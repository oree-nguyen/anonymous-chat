import { initI18n, setLocale, t } from './i18n.js';
import { estimatePassphraseStrength } from './crypto/kdf.js';
import { encryptPassphraseMessage, decryptPassphraseMessage, encryptRatchetMessage, decryptRatchetMessage } from './crypto/message.js';
import { packPayload, unpackPayload } from './crypto/emoji-codec.js';
import { createRatchetState, RATCHET_DIRECTIONS } from './crypto/ratchet.js';
import { RatchetState } from './crypto/ratchet.js';
import { fromUtf8, concatBytes, zeroize, toBase64, fromBase64 } from './crypto/bytes.js';
import { generateOtpKey, otpEncrypt, otpDecrypt, OtpUsageTracker, OTP_DIRECTIONS, otpDirectionCode, otpDirectionFromCode } from './crypto/otp.js';
import { PeerTransport } from './webrtc/peer.js';
import { decodeHandshake } from './webrtc/handshake.js';
import { FallbackController } from './webrtc/fallback.js';
import { roleForPublicKeys } from './crypto/ecdh.js';
import { configureSessionPersistence, deleteSessionState, getSessionConfig, hasStoredSessionState, loadSessionState, saveSessionState, updatePinFailure } from './session-vault.js';
import { encryptBackup, decryptBackup } from './backup-vault.js';
import { encodeQr, drawQrToCanvas } from './qr/qr-encode.js';
import { decodeQrImageData } from './qr/qr-decode.js';

const $ = (selector) => document.querySelector(selector);
const STORAGE_PREFIX = 'anonymous-chat:';
const THEME_KEY = `${STORAGE_PREFIX}theme`;
const PROFILE_KEY = `${STORAGE_PREFIX}profile-name`;
const TURN_KEY = `${STORAGE_PREFIX}turn-server`;
const AUTO_LOCK_KEY = `${STORAGE_PREFIX}auto-lock`;
const otpTracker = new OtpUsageTracker(localStorage);
let transport = null;
let fallback = null;
let sendRatchet = null;
let receiveRatchet = null;
let otpKey = null;
let errorTimer = null;
let conversationMessages = [];
let connectionMode = 'manual';
let safetyConfirmed = false;
let handshakeRole = null;
let handshakeStage = 'choice';
let sessionConfig = null;
let sessionPin = '';
let restoredRemotePublicKey = null;
let localSafetyConfirmed = false;
let remoteSafetyConfirmed = false;
let verificationStartedAt = 0;
let verificationTimer = null;
let pendingSenderName = '';
let answerPeerConfirmed = false;
let qrStream = null;
let qrFrameRequest = null;
let autoLockTimer = null;
let autoLocked = false;
const AUTO_LOCK_ITERATIONS = 100_000;

function profileName() {
  return localStorage.getItem(PROFILE_KEY)?.trim().slice(0, 60) || '';
}

function iceServers() {
  const value = localStorage.getItem(TURN_KEY)?.trim();
  return value && /^turns?:/iu.test(value) ? [{ urls: value }] : undefined;
}

function autoLockConfig() {
  try {
    const config = JSON.parse(localStorage.getItem(AUTO_LOCK_KEY) || 'null');
    return config?.enabled && config.salt && config.verifier ? config : null;
  } catch { return null; }
}

async function autoLockVerifier(pin, salt) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: AUTO_LOCK_ITERATIONS }, material, 256));
}

function resetAutoLockTimer() {
  if (autoLocked) return;
  clearTimeout(autoLockTimer);
  const config = autoLockConfig();
  if (config) autoLockTimer = setTimeout(lockWorkspace, Math.max(1, config.minutes) * 60_000);
}

function lockWorkspace() {
  if (!autoLockConfig() || autoLocked) return;
  autoLocked = true;
  document.body.classList.add('auto-locked');
  $('#auto-lock-screen').classList.remove('is-hidden');
  $('#unlock-pin').value = '';
  $('#unlock-pin').focus();
}

async function unlockWorkspace() {
  const config = autoLockConfig();
  if (!config) return;
  const candidate = await autoLockVerifier($('#unlock-pin').value, fromBase64(config.salt));
  const expected = fromBase64(config.verifier);
  if (candidate.length !== expected.length || candidate.some((byte, index) => byte !== expected[index])) {
    $('#unlock-error').classList.remove('is-hidden');
    return;
  }
  $('#unlock-error').classList.add('is-hidden');
  autoLocked = false;
  document.body.classList.remove('auto-locked');
  $('#auto-lock-screen').classList.add('is-hidden');
  resetAutoLockTimer();
}

function updateProfileControls() {
  const value = $('#profile-name')?.value.trim() || '';
  const ready = value.length > 0;
  $('#choose-start').disabled = !ready;
  $('#choose-join').disabled = !ready;
  if (ready) localStorage.setItem(PROFILE_KEY, value.slice(0, 60));
}

function showPeerPreview(element, name, key) {
  if (!element) return;
  if (!name) {
    element.classList.add('is-hidden');
    return;
  }
  element.textContent = t(key).replace('{name}', name);
  element.classList.remove('is-hidden');
}

function handshakeLink(code) {
  return `${location.origin}${location.pathname}#code=${encodeURIComponent(code)}`;
}

async function shareHandshakeCode(code) {
  const url = handshakeLink(code);
  if (navigator.share) {
    await navigator.share({ title: 'anonymous-chat handshake', text: t('shareLinkWarning'), url });
    return;
  }
  await navigator.clipboard.writeText(url);
  reportError(new Error(t('copied')));
}

function renderHandshakeQr(code, canvas) {
  const qr = encodeQr(new TextEncoder().encode(code));
  drawQrToCanvas(qr, canvas, 4, 4);
  canvas.classList.remove('is-hidden');
}

function stopQrScanner() {
  if (qrFrameRequest) cancelAnimationFrame(qrFrameRequest);
  qrFrameRequest = null;
  qrStream?.getTracks().forEach((track) => track.stop());
  qrStream = null;
  const video = $('#qr-video');
  if (video) video.srcObject = null;
  $('#qr-scanner')?.classList.add('is-hidden');
}

async function scanQr() {
  stopQrScanner();
  if (!navigator.mediaDevices?.getUserMedia) throw new Error(t('cameraUnavailable'));
  qrStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
  const video = $('#qr-video');
  const frame = $('#qr-frame');
  video.srcObject = qrStream;
  $('#qr-scanner').classList.remove('is-hidden');
  await video.play();
  const scan = async () => {
    if (!qrStream) return;
    if (video.videoWidth && video.videoHeight) {
      frame.width = video.videoWidth;
      frame.height = video.videoHeight;
      const context = frame.getContext('2d', { willReadFrequently: true });
      context.drawImage(video, 0, 0, frame.width, frame.height);
      try {
        const bytes = decodeQrImageData(context.getImageData(0, 0, frame.width, frame.height).data, frame.width, frame.height);
        const code = new TextDecoder().decode(bytes);
        $('#offer-input').value = code;
        const decoded = await awaitHandshakeDecode(code);
        pendingSenderName = decoded.senderName;
        showPeerPreview($('#offer-sender-preview'), pendingSenderName, 'senderWantsToChat');
        stopQrScanner();
        setHandshakeStage('b-paste');
        return;
      } catch { /* keep scanning until a valid anonymous-chat code is found */ }
    }
    qrFrameRequest = requestAnimationFrame(() => { void scan(); });
  };
  scan();
}

async function awaitHandshakeDecode(code) {
  return decodeHandshake(code);
}

function backupSnapshot() {
  if (!sendRatchet || !receiveRatchet) throw new Error(t('backupRequiresSession'));
  const contacts = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key?.startsWith(`${STORAGE_PREFIX}conversation:`)) continue;
    try { contacts.push(JSON.parse(localStorage.getItem(key))); } catch { /* ignore damaged metadata */ }
  }
  return {
    nickname: $('#contact-name').value.trim() || 'contact',
    remotePublicKey: transport?.remotePublicKey ? Array.from(transport.remotePublicKey) : restoredRemotePublicKey,
    safetyNumber: $('#safety-number').textContent,
    role: handshakeRole,
    send: sendRatchet.exportPersistenceState(),
    receive: receiveRatchet.exportPersistenceState(),
    contacts,
  };
}

async function importHandshakeLink() {
  const match = location.hash.match(/^#code=(.+)$/u);
  if (!match) return false;
  const code = decodeURIComponent(match[1]);
  history.replaceState(null, '', `${location.pathname}${location.search}`);
  $('#offer-input').value = code;
  const decoded = await decodeHandshake(code);
  pendingSenderName = decoded.senderName;
  showPeerPreview($('#offer-sender-preview'), pendingSenderName, 'senderWantsToChat');
  setHandshakeStage('b-paste');
  setView('app');
  return true;
}

const handshakeProgress = {
  choice: null,
  'a-enter': 1,
  'a-wait': 2,
  'b-paste': 1,
  'b-response': 2,
  verifying: 3,
  chatting: 4,
};

function prefersReducedMotion() {
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function transition(update) {
  if (document.startViewTransition && !prefersReducedMotion()) return document.startViewTransition(update);
  update();
  return null;
}

function setView(view) {
  transition(() => {
    const app = $('#app-main');
    const landing = $('#landing-main');
    const appActive = view === 'app';
    app.hidden = !appActive;
    landing.hidden = appActive;
    document.body.dataset.view = appActive ? 'app' : 'landing';
    $('.skip-link').href = appActive ? '#app-main' : '#landing-main';
  });
  requestAnimationFrame(() => {
    const target = view === 'app' ? $('#live-panel h1') : $('#page-title');
    target?.setAttribute('tabindex', '-1');
    target?.focus({ preventScroll: true });
    scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  });
}

function setupVisualEffects() {
  const particleField = $('#ambient-particles');
  if (particleField) {
    for (let index = 0; index < 40; index += 1) {
      const particle = document.createElement('span');
      particle.className = 'ambient-particle';
      particle.style.setProperty('--particle-x', `${(index * 37.7) % 100}%`);
      particle.style.setProperty('--particle-y', `${(index * 61.3) % 100}%`);
      particle.style.setProperty('--particle-size', `${1 + (index % 3) * 0.6}px`);
      particle.style.setProperty('--particle-duration', `${4 + (index % 9)}s`);
      particle.style.setProperty('--particle-delay', `${-(index % 5)}s`);
      particleField.append(particle);
    }
  }

  document.querySelectorAll('.bento-card, .trust-console, .workflow-block, .chat-main, .security-panel, .closing-cta').forEach((card) => {
    card.classList.add('spotlight-card');
    const layer = document.createElement('span');
    layer.className = 'spotlight-layer';
    layer.setAttribute('aria-hidden', 'true');
    card.prepend(layer);
    card.addEventListener('pointermove', (event) => {
      const bounds = card.getBoundingClientRect();
      card.style.setProperty('--spotlight-x', `${event.clientX - bounds.left}px`);
      card.style.setProperty('--spotlight-y', `${event.clientY - bounds.top}px`);
    });
    card.addEventListener('pointerleave', () => {
      card.style.setProperty('--spotlight-x', '-500px');
      card.style.setProperty('--spotlight-y', '-500px');
    });
  });

  if (!matchMedia('(pointer: coarse)').matches) {
    document.querySelectorAll('[data-magnetic]').forEach((button) => {
      button.addEventListener('pointermove', (event) => {
        const bounds = button.getBoundingClientRect();
        button.style.setProperty('--magnetic-x', `${(event.clientX - (bounds.left + bounds.width / 2)) * 0.12}px`);
        button.style.setProperty('--magnetic-y', `${(event.clientY - (bounds.top + bounds.height / 2)) * 0.12}px`);
      });
      button.addEventListener('pointerleave', () => {
        button.style.setProperty('--magnetic-x', '0px');
        button.style.setProperty('--magnetic-y', '0px');
      });
    });
  }

  const hero = $('.hero');
  const heroImage = $('.hero-backdrop img');
  if (hero && heroImage && !prefersReducedMotion()) {
    let ticking = false;
    const updateParallax = () => {
      const offset = Math.min(120, Math.max(0, scrollY - hero.offsetTop) * 0.2);
      heroImage.style.setProperty('--hero-parallax', `${offset}px`);
      ticking = false;
    };
    addEventListener('scroll', () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(updateParallax);
    }, { passive: true });
    updateParallax();
  }
}

function setTheme(theme) {
  const selected = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = selected;
  localStorage.setItem(THEME_KEY, selected);
  document.querySelectorAll('.theme-toggle').forEach((button) => {
    button.setAttribute('aria-pressed', String(selected === 'light'));
    button.title = selected === 'light' ? t('switchDark') : t('switchLight');
  });
}

function toggleElements(elements, hidden) {
  elements.filter(Boolean).forEach((element) => element.classList.toggle('is-hidden', hidden));
}

function setHandshakeStage(stage) {
  handshakeStage = stage;
  const rolePicker = $('#handshake-role-picker');
  const setup = $('#live-setup');
  const starter = $('#create-offer')?.closest('.workflow-block');
  const joiner = $('#create-answer')?.closest('.workflow-block');
  const chatArea = $('#chat-area');
  const chatMain = $('.chat-main');
  const securityPanel = $('.chat-area > .security-panel');
  const progress = $('#handshake-progress');
  const progressLabel = $('#handshake-progress-label');
  const restore = $('#session-restore');
  const stages = handshakeProgress[stage];

  transition(() => {
    rolePicker?.classList.toggle('is-hidden', stage !== 'choice');
    restore?.classList.toggle('is-hidden', stage !== 'restore-pin');
    setup?.classList.toggle('is-hidden', !['a-enter', 'a-wait', 'b-paste', 'b-response'].includes(stage));
    progress?.classList.toggle('is-hidden', stages === null || stages === undefined);
    if (progressLabel && stages !== null && stages !== undefined) {
      const progressKey = stage === 'chatting' ? 'stepFourOfFour' : stage === 'verifying' ? 'stepThreeOfFour' : ['a-wait', 'b-response'].includes(stage) ? 'stepTwoOfFour' : 'stepOneOfFour';
      progressLabel.textContent = t(progressKey);
    }
    progress?.querySelectorAll('.progress-dots span').forEach((dot, index) => {
      dot.classList.toggle('is-current', index === stages - 1);
      dot.classList.toggle('is-complete', index < stages - 1);
    });

    toggleElements([starter], !['a-enter', 'a-wait'].includes(stage));
    toggleElements([joiner], !['b-paste', 'b-response'].includes(stage));
    if (starter) {
      const contactLabel = starter.querySelector('label[for="contact-name"]');
      const contact = $('#contact-name');
      const note = contact?.nextElementSibling?.nextElementSibling;
      const create = $('#create-offer');
      toggleElements([contactLabel, contact, note, create], stage !== 'a-enter');
      toggleElements([$('#offer-output-block'), $('#answer-input-block')], stage !== 'a-wait');
    }
    if (joiner) {
      const offerLabel = joiner.querySelector('label[for="offer-input"]');
      const offer = $('#offer-input');
      const create = $('#create-answer');
      const ip = joiner.querySelector('.ip-disclosure');
      toggleElements([offerLabel, offer, create], stage !== 'b-paste');
      toggleElements([$('#answer-output-block')], stage !== 'b-response');
      toggleElements([ip], stage !== 'b-response');
    }

    const verifying = stage === 'verifying';
    const chatting = stage === 'chatting';
    document.body.dataset.mobileChat = String(verifying || chatting);
    chatArea?.classList.toggle('is-hidden', !verifying && !chatting);
    chatArea?.classList.toggle('is-verifying', verifying);
    chatMain?.classList.toggle('is-chat-hidden', verifying);
    securityPanel?.classList.toggle('is-hidden', !verifying);
    $('#open-safety')?.classList.toggle('is-hidden', !chatting);
    if (chatting) $('#open-safety')?.setAttribute('aria-expanded', 'false');
  });
  updateSecurityState();
}

function enterVerifyingStage() {
  beginSafetyVerification();
  setHandshakeStage('verifying');
  updateSecurityState();
}

function enterChatting() {
  if (!safetyConfirmed) return;
  setHandshakeStage('chatting');
  $('#chat-message')?.focus();
}

function reportError(error, publicMessage = null) {
  const region = $('#error-region');
  const message = publicMessage ?? (error instanceof Error ? error.message : String(error));
  region.textContent = `${t('errorPrefix')}: ${message}`;
  region.classList.add('has-error');
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => region.classList.remove('has-error'), 9000);
  console.error(error);
}

async function runDecryption(action, button = null) {
  try {
    if (button) button.disabled = true;
    await action();
  } catch (error) {
    if (error instanceof Error && /checksum failed/iu.test(error.message)) {
      reportError(error, t('checksumFailed'));
    } else if (error instanceof Error && /skip more than|already destroyed/iu.test(error.message)) {
      $('#ratchet-recovery')?.classList.remove('is-hidden');
      reportError(error, t('ratchetDrift'));
    } else reportError(error, t('openFailed'));
  } finally {
    if (button) button.disabled = false;
  }
}

async function run(action, button = null) {
  try {
    if (button) button.disabled = true;
    await action();
  } catch (error) {
    reportError(error);
  } finally {
    if (button) button.disabled = false;
  }
}

function setConnectionMode(mode) {
  connectionMode = mode;
  const status = $('#connection-status');
  const detail = $('#connection-detail');
  const line = status.closest('.status-line');
  line.dataset.mode = mode;
  if (mode === 'p2p') {
    status.textContent = t('p2pStatus');
    detail.textContent = t('p2pDetail');
    $('#fallback-transfer').classList.add('is-hidden');
  } else if (mode === 'connecting') {
    status.textContent = t('connectingStatus');
    detail.textContent = t('notConnected');
  } else {
    status.textContent = t('manualStatus');
    detail.textContent = t('fallbackDetail');
    if (sendRatchet) $('#fallback-transfer').classList.remove('is-hidden');
  }
  updateSecurityState();
}

function updateSecurityState() {
  const state = $('#security-state');
  const label = $('#security-label');
  const message = $('#chat-message');
  const send = $('#send-message');
  const confirm = $('#confirm-safety');
  if (!state || !label || !message || !send || !confirm) return;

  const ready = Boolean(sendRatchet && safetyConfirmed);
  const securityMode = !safetyConfirmed ? 'unverified' : connectionMode === 'manual' ? 'manual' : 'safe';
  const labelKey = securityMode === 'safe' ? 'safeState' : securityMode === 'manual' ? 'manualState' : 'unverifiedState';
  state.dataset.state = securityMode;
  state.querySelector('.status-symbol').textContent = securityMode === 'safe' ? '✓' : securityMode === 'manual' ? '◇' : '!';
  label.textContent = t(labelKey);
  const compactLabel = $('#compact-security-label');
  if (compactLabel) compactLabel.textContent = t(labelKey);
  const compactSymbol = $('#open-safety .status-symbol');
  if (compactSymbol) compactSymbol.textContent = securityMode === 'safe' ? '✓' : securityMode === 'manual' ? '◇' : '!';
  message.disabled = !ready;
  send.disabled = !ready;
  const entered = ($('#peer-safety-number')?.value.trim().length ?? 0) === 8;
  confirm.disabled = !sendRatchet || safetyConfirmed || localSafetyConfirmed || !entered;
  confirm.textContent = safetyConfirmed ? t('verifiedState') : t('confirmMatch');
  message.placeholder = safetyConfirmed ? t('messagePlaceholder') : t('verifyBeforeWriting');
}

function beginSafetyVerification() {
  clearInterval(verificationTimer);
  localSafetyConfirmed = false;
  remoteSafetyConfirmed = false;
  safetyConfirmed = false;
  verificationStartedAt = Date.now();
  const input = $('#peer-safety-number');
  const error = $('#verification-error');
  const danger = $('#verification-danger');
  $('#verification-delay')?.classList.remove('is-warning');
  if (input) {
    input.value = '';
    input.disabled = true;
  }
  error?.classList.add('is-hidden');
  danger?.classList.add('is-hidden');
  const updateDelay = () => {
    const remaining = Math.max(0, 8 - Math.floor((Date.now() - verificationStartedAt) / 1000));
    const delay = $('#verification-delay');
    if (delay) delay.textContent = remaining > 0 ? `${t('verificationDelay')} (${remaining}s)` : t('verificationReady');
    if (input && remaining === 0) input.disabled = false;
    if (remaining === 0) clearInterval(verificationTimer);
    updateSecurityState();
  };
  verificationTimer = setInterval(updateDelay, 250);
  updateDelay();
}

function completeSafetyIfMutual() {
  if (!localSafetyConfirmed || !remoteSafetyConfirmed) return;
  safetyConfirmed = true;
  clearInterval(verificationTimer);
  updateSecurityState();
  enterChatting();
}

function handleVerificationAck() {
  remoteSafetyConfirmed = true;
  completeSafetyIfMutual();
}

function renderConversation(messages = conversationMessages) {
  const list = $('#message-list');
  list.replaceChildren();
  if (!messages.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = t('emptyConversation');
    list.append(empty);
    return;
  }
  for (const entry of messages) {
    const item = document.createElement('div');
    item.className = `message${entry.sent ? ' is-sent' : ''}`;
    const content = document.createElement('span');
    content.className = 'message-content';
    content.textContent = entry.text;
    const meta = document.createElement('span');
    meta.className = 'message-meta';
    const date = new Date(entry.createdAt);
    meta.textContent = Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat(document.documentElement.lang, { hour: '2-digit', minute: '2-digit' }).format(date);
    const copy = document.createElement('button');
    copy.className = 'message-copy';
    copy.type = 'button';
    copy.dataset.messageText = entry.text;
    copy.setAttribute('aria-label', t('copyMessage'));
    copy.textContent = t('copy');
    item.append(content, meta, copy);
    list.append(item);
  }
  list.scrollTop = list.scrollHeight;
}

function appendMessage(text, sent) {
  conversationMessages.push({ text, sent, createdAt: new Date().toISOString() });
  renderConversation();
}

function persistConversation() {
  if (!sendRatchet || !receiveRatchet) return;
  const nickname = $('#contact-name').value.trim() || 'contact';
  const storageKey = `${STORAGE_PREFIX}conversation:${nickname}`;
  let previous = {};
  try { previous = JSON.parse(localStorage.getItem(storageKey) ?? '{}'); } catch { previous = {}; }
  const remotePublicKey = transport?.remotePublicKey ? Array.from(transport.remotePublicKey) : previous.remotePublicKey;
  const record = {
    nickname,
    remotePublicKey,
    sendRatchet: sendRatchet.serialize(),
    receiveRatchet: receiveRatchet.serialize(),
    updatedAt: new Date().toISOString(),
  };
  localStorage.setItem(storageKey, JSON.stringify(record));
  populateContacts();
  void persistEncryptedSession();
}

async function persistEncryptedSession() {
  if (!sessionConfig || !sendRatchet || !receiveRatchet) return;
  const send = sendRatchet.exportPersistenceState();
  const receive = receiveRatchet.exportPersistenceState();
  const state = {
    nickname: $('#contact-name').value.trim() || 'contact',
    remotePublicKey: transport?.remotePublicKey ? Array.from(transport.remotePublicKey) : restoredRemotePublicKey,
    safetyNumber: $('#safety-number')?.textContent,
    role: handshakeRole,
    send,
    receive,
  };
  try {
    await saveSessionState(sessionConfig, state, sessionPin);
  } catch (error) {
    reportError(error, t('sessionSaveFailed'));
  } finally {
    zeroize(send.chainKey);
    zeroize(receive.chainKey);
  }
}

function selectedSessionMethod() {
  return document.querySelector('input[name="session-method"]:checked')?.value || 'pin';
}

function refreshSessionOptions() {
  const enabled = $('#remember-session')?.checked === true;
  $('#session-options')?.classList.toggle('is-hidden', !enabled);
  $('#pin-fields')?.classList.toggle('is-hidden', selectedSessionMethod() !== 'pin');
}

function setSessionNote(message) {
  const note = $('#session-persistence-note');
  if (note) note.textContent = message;
}

function restoreRatchets(state, pin = '') {
  sendRatchet = RatchetState.restorePersistenceState(state.send);
  receiveRatchet = RatchetState.restorePersistenceState(state.receive);
  restoredRemotePublicKey = Array.isArray(state.remotePublicKey) ? new Uint8Array(state.remotePublicKey) : null;
  handshakeRole = state.role || 'start';
  safetyConfirmed = true;
  localSafetyConfirmed = true;
  remoteSafetyConfirmed = true;
  sessionPin = pin;
  $('#contact-name').value = state.nickname || 'contact';
  $('#safety-number').textContent = state.safetyNumber || '--------';
  fallback = new FallbackController({ sendRatchet, receiveRatchet, persist: persistConversation });
  transport = null;
  setConnectionMode('manual');
  renderConversation([]);
  enterChatting();
}

async function restoreConfiguredSession(config, pin = '') {
  const state = await loadSessionState(config, pin);
  if (!state) throw new Error('No persisted session was found.');
  restoreRatchets(state, pin);
}

async function initializeSessionPersistence() {
  sessionConfig = getSessionConfig();
  if (!sessionConfig) return;
  $('#remember-session').checked = true;
  refreshSessionOptions();
  if (sessionConfig.method === 'browser') {
    try {
      if (await hasStoredSessionState(sessionConfig)) await restoreConfiguredSession(sessionConfig);
      else setHandshakeStage('choice');
    } catch (error) {
      await deleteSessionState();
      sessionConfig = null;
      $('#remember-session').checked = false;
      refreshSessionOptions();
      reportError(error, t('browserPersistenceUnavailable'));
      setHandshakeStage('choice');
    }
    return;
  }
  if (await hasStoredSessionState(sessionConfig)) setHandshakeStage('restore-pin');
}

function populateContacts() {
  const list = $('#saved-contacts');
  const visibleList = $('#contact-list');
  list.replaceChildren();
  visibleList?.replaceChildren();
  let count = 0;
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key?.startsWith(`${STORAGE_PREFIX}conversation:`)) continue;
    const option = document.createElement('option');
    option.value = key.slice(`${STORAGE_PREFIX}conversation:`.length);
    list.append(option);
    if (visibleList) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'contact-button';
      button.textContent = option.value;
      button.addEventListener('click', () => {
        $('#contact-name').value = option.value;
        setView('app');
        $('#contact-name').focus();
      });
      visibleList.append(button);
    }
    count += 1;
  }
  if (visibleList && count === 0) {
    const empty = document.createElement('p');
    empty.textContent = t('noContacts');
    visibleList.append(empty);
  }
}

function scrubLegacyConversationStorage() {
  const keys = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key?.startsWith(`${STORAGE_PREFIX}conversation:`)) keys.push(key);
  }
  for (const key of keys) {
    try {
      const saved = JSON.parse(localStorage.getItem(key) ?? '{}');
      const safeRecord = {
        nickname: typeof saved.nickname === 'string' ? saved.nickname : key.slice(`${STORAGE_PREFIX}conversation:`.length),
        remotePublicKey: Array.isArray(saved.remotePublicKey) ? saved.remotePublicKey : undefined,
        sendRatchet: { position: Number.isSafeInteger(saved.sendRatchet?.position) ? saved.sendRatchet.position : 0 },
        receiveRatchet: { position: Number.isSafeInteger(saved.receiveRatchet?.position) ? saved.receiveRatchet.position : 0 },
        updatedAt: typeof saved.updatedAt === 'string' ? saved.updatedAt : new Date().toISOString(),
      };
      localStorage.setItem(key, JSON.stringify(safeRecord));
    } catch {
      localStorage.removeItem(key);
    }
  }
}

function bindTransport(instance) {
  instance.addEventListener('open', () => {
    if (handshakeRole === 'join' && handshakeStage === 'b-response') enterVerifyingStage();
    if (handshakeRole === 'start' && handshakeStage === 'a-wait' && safetyConfirmed) enterChatting();
  });
  instance.addEventListener('heartbeattimeout', () => {
    if (!sendRatchet) return;
    setConnectionMode('connecting');
    $('#fallback-transfer')?.classList.remove('is-hidden');
    reportError(new Error(t('heartbeatTimeout')));
  });
  instance.addEventListener('heartbeat', () => {
    if (connectionMode === 'connecting' && instance.channel?.readyState === 'open') setConnectionMode('p2p');
  });
  instance.addEventListener('message', (event) => {
    if (typeof event.detail === 'string') {
      if (event.detail === 'verification_ack') handleVerificationAck();
      return;
    }
    runDecryption(async () => {
      const plaintext = await decryptRatchetMessage(receiveRatchet, new Uint8Array(event.detail));
      appendMessage(plaintext, false);
      persistConversation();
    });
  });
  instance.addEventListener('channelerror', () => reportError(new Error(t('directChannelError'))));
}

async function initializeConversation({ deferVerification = false } = {}) {
  if (!transport?.rootKey) throw new Error(t('rootKeyMissing'));
  if (!sendRatchet || !receiveRatchet) {
    const role = roleForPublicKeys(transport.localPublicKey, transport.remotePublicKey);
    $('#otp-role').value = role;
    const sendDirection = role === 'A' ? RATCHET_DIRECTIONS.A_TO_B : RATCHET_DIRECTIONS.B_TO_A;
    const receiveDirection = role === 'A' ? RATCHET_DIRECTIONS.B_TO_A : RATCHET_DIRECTIONS.A_TO_B;
    const rootKey = transport.rootKey;
    try {
      [sendRatchet, receiveRatchet] = await Promise.all([
        createRatchetState(rootKey, sendDirection),
        createRatchetState(rootKey, receiveDirection),
      ]);
    } finally {
      rootKey.fill(0);
      transport.rootKey = null;
    }
  }
  fallback = new FallbackController({ sendRatchet, receiveRatchet, persist: persistConversation });
  fallback.addEventListener('modechange', (event) => setConnectionMode(event.detail));
  fallback.attach(transport);
  $('#reconnect').disabled = false;
  $('#safety-number').textContent = await transport.getSafetyNumber();
  $('#safety-number').title = t('verifySafety');
  $('#ratchet-recovery')?.classList.add('is-hidden');
  safetyConfirmed = false;
  localSafetyConfirmed = false;
  remoteSafetyConfirmed = false;
  updateSecurityState();
  renderConversation();
  persistConversation();
  if (!deferVerification) enterVerifyingStage();
}

function disposeConversationSecrets({ clearHistory = true } = {}) {
  sendRatchet?.dispose();
  receiveRatchet?.dispose();
  sendRatchet = null;
  receiveRatchet = null;
  if (clearHistory) {
    for (const message of conversationMessages) message.text = '';
    conversationMessages = [];
  }
  safetyConfirmed = false;
  localSafetyConfirmed = false;
  remoteSafetyConfirmed = false;
  updateSecurityState();
}

function freshTransport() {
  transport?.close();
  transport = new PeerTransport({ iceServers: iceServers() });
  bindTransport(transport);
  return transport;
}

$('#choose-start').addEventListener('click', () => {
  updateProfileControls();
  handshakeRole = 'start';
  setHandshakeStage('a-enter');
  $('#contact-name').focus();
});

$('#choose-join').addEventListener('click', () => {
  updateProfileControls();
  handshakeRole = 'join';
  setHandshakeStage('b-paste');
  $('#offer-input').focus();
});

$('#create-offer').addEventListener('click', (event) => run(async () => {
  handshakeRole = 'start';
  setConnectionMode('connecting');
  disposeConversationSecrets();
  renderConversation([]);
  const peer = freshTransport();
  const code = await peer.createOffer({ senderName: profileName() });
  $('#offer-output').value = code;
  $('#offer-output-block').classList.remove('is-hidden');
  $('#answer-input-block').classList.remove('is-hidden');
  $('#connection-detail').textContent = t('offerReady');
  setHandshakeStage('a-wait');
}, event.currentTarget));

$('#create-answer').addEventListener('click', (event) => run(async () => {
  handshakeRole = 'join';
  const code = $('#offer-input').value.trim();
  if (!code) throw new Error(t('offerRequired'));
  const decoded = await decodeHandshake(code);
  pendingSenderName = decoded.senderName;
  showPeerPreview($('#offer-sender-preview'), pendingSenderName, 'senderWantsToChat');
  const reconnect = decoded.kind === 'reconnect-offer';
  if (reconnect && !transport) throw new Error(t('reconnectSessionRequired'));
  if (!reconnect) {
    disposeConversationSecrets();
    renderConversation([]);
  }
  setConnectionMode('connecting');
  const peer = reconnect && transport ? transport : freshTransport();
  const answer = await peer.acceptOffer(code, { reconnect, senderName: profileName() });
  $('#answer-output').value = answer;
  $('#answer-output-block').classList.remove('is-hidden');
  $('#connection-detail').textContent = t('answerReady');
  if (!sendRatchet) await initializeConversation({ deferVerification: true });
  else if (peer.rootKey) {
    peer.rootKey.fill(0);
    peer.rootKey = null;
  }
  setHandshakeStage('b-response');
  if (peer.channel?.readyState === 'open') enterVerifyingStage();
}, event.currentTarget));

$('#accept-answer').addEventListener('click', (event) => run(async () => {
  handshakeRole = 'start';
  if (!transport) throw new Error(t('createOfferFirst'));
  const code = $('#answer-input').value.trim();
  if (!code) throw new Error(t('answerRequired'));
  const decoded = await decodeHandshake(code);
  const reconnect = decoded.kind === 'reconnect-answer';
  if (!reconnect && decoded.senderName && !answerPeerConfirmed) {
    showPeerPreview($('#answer-peer-preview'), decoded.senderName, 'youWillConnectTo');
    answerPeerConfirmed = true;
    throw new Error(t('confirmPeerThenContinue'));
  }
  await transport.acceptAnswer(code, { reconnect });
  answerPeerConfirmed = false;
  if (!sendRatchet) await initializeConversation();
  else if (transport.rootKey) {
    transport.rootKey.fill(0);
    transport.rootKey = null;
  }
  setConnectionMode(transport.channel?.readyState === 'open' ? 'p2p' : 'connecting');
  if (sendRatchet && safetyConfirmed && transport.channel?.readyState === 'open') enterChatting();
}, event.currentTarget));

$('#reconnect').addEventListener('click', (event) => run(async () => {
  handshakeRole = 'start';
  if (!transport || !sendRatchet) throw new Error(t('conversationMissing'));
  setConnectionMode('connecting');
  const code = await transport.createOffer({ reconnect: true, senderName: profileName() });
  $('#offer-output').value = code;
  $('#offer-output-block').classList.remove('is-hidden');
  $('#answer-input-block').classList.remove('is-hidden');
  $('#connection-detail').textContent = t('reconnectReady');
  setHandshakeStage('a-wait');
  $('#live-setup').scrollIntoView({ behavior: 'smooth', block: 'start' });
}, event.currentTarget));

$('#chat-form').addEventListener('submit', (event) => {
  event.preventDefault();
  run(async () => {
    if (!safetyConfirmed) throw new Error(t('verificationRequired'));
    const field = $('#chat-message');
    const text = field.value;
    if (!text.trim()) throw new Error(t('messageRequired'));
    const envelope = await encryptRatchetMessage(sendRatchet, text);
    if (transport?.channel?.readyState === 'open') {
      transport.send(envelope);
    } else {
      $('#fallback-output').value = packPayload(envelope);
      $('#fallback-transfer').classList.remove('is-hidden');
      setConnectionMode('manual');
    }
    appendMessage(text, true);
    field.value = '';
    persistConversation();
  }, event.submitter);
});

$('#open-fallback').addEventListener('click', (event) => runDecryption(async () => {
  const value = $('#fallback-input').value.trim();
  if (!value) throw new Error(t('incomingRequired'));
  const plaintext = await decryptRatchetMessage(receiveRatchet, unpackPayload(value));
  appendMessage(plaintext, false);
  $('#fallback-input').value = '';
  persistConversation();
}, event.currentTarget));

function updateStrength() {
  const result = estimatePassphraseStrength($('#passphrase').value);
  const note = $('#strength-note');
  note.textContent = `${t(result.accepted ? 'strengthStrong' : 'strengthWeak')} (${result.entropy} ${t('estimatedBits')})`;
  note.classList.toggle('is-error', !result.accepted);
  note.classList.toggle('is-success', result.accepted);
  $('#weak-override').classList.toggle('is-hidden', result.accepted);
  const overrideAccepted = $('#weak-override-confirmation').value.trim() === t('weakOverridePhrase');
  $('#manual-encrypt').disabled = !result.accepted && !overrideAccepted;
  return result;
}

$('#passphrase').addEventListener('input', updateStrength);
$('#weak-override-confirmation').addEventListener('input', updateStrength);
$('#manual-encrypt').addEventListener('click', (event) => run(async () => {
  const strength = updateStrength();
  if (!strength.accepted && $('#weak-override-confirmation').value.trim() !== t('weakOverridePhrase')) throw new Error(t('passphraseWeak'));
  const plaintext = $('#manual-plaintext').value;
  if (!plaintext) throw new Error(t('messageRequired'));
  $('#manual-output').value = packPayload(await encryptPassphraseMessage($('#passphrase').value, plaintext));
}, event.currentTarget));

$('#manual-decrypt').addEventListener('click', (event) => runDecryption(async () => {
  const strength = updateStrength();
  if (!strength.accepted) throw new Error(t('passphraseWeak'));
  const plaintext = await decryptPassphraseMessage($('#passphrase').value, unpackPayload($('#manual-input').value.trim()));
  $('#manual-result').textContent = plaintext;
  $('#manual-result').classList.add('has-result');
}, event.currentTarget));

$('#otp-file').addEventListener('change', (event) => run(async () => {
  const file = event.target.files[0];
  if (!file) return;
  otpKey = new Uint8Array(await file.arrayBuffer());
  $('#otp-file-status').textContent = `${t('keyLoaded')}: ${file.name} (${new Intl.NumberFormat(document.documentElement.lang).format(otpKey.length)} ${t('bytes')})`;
}));

$('#generate-otp').addEventListener('click', (event) => run(async () => {
  const length = Number($('#otp-key-size').value);
  otpKey = generateOtpKey(length);
  const blob = new Blob([otpKey], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `anonymous-chat-key-${Date.now()}.bin`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  $('#otp-file-status').textContent = t('keyGenerated');
}, event.currentTarget));

$('#otp-encrypt').addEventListener('click', (event) => run(async () => {
  if (!otpKey) throw new Error(t('otpKeyRequired'));
  const plaintext = $('#otp-plaintext').value;
  if (!plaintext) throw new Error(t('messageRequired'));
  const role = $('#otp-role').value;
  const direction = role === 'A' ? OTP_DIRECTIONS.A_TO_B : OTP_DIRECTIONS.B_TO_A;
  const encrypted = await otpEncrypt(plaintext, otpKey, otpTracker, direction);
  const offset = new Uint8Array(4);
  new DataView(offset.buffer).setUint32(0, encrypted.offset, false);
  $('#otp-output').value = packPayload(concatBytes(
    Uint8Array.of(4, otpDirectionCode(encrypted.direction)),
    offset,
    encrypted.ciphertext,
    encrypted.tag,
  ));
}, event.currentTarget));

$('#otp-decrypt').addEventListener('click', (event) => runDecryption(async () => {
  if (!otpKey) throw new Error(t('otpKeyRequired'));
  const envelope = unpackPayload($('#otp-input').value.trim());
  if (envelope[0] !== 4 || envelope.length < 166) throw new Error(t('otpEnvelopeInvalid'));
  const direction = otpDirectionFromCode(envelope[1]);
  const role = $('#otp-role').value;
  const expectedDirection = role === 'A' ? OTP_DIRECTIONS.B_TO_A : OTP_DIRECTIONS.A_TO_B;
  if (direction !== expectedDirection) throw new Error(t('otpDirectionInvalid'));
  const offset = new DataView(envelope.buffer, envelope.byteOffset + 2, 4).getUint32(0, false);
  const ciphertext = envelope.slice(6, -32);
  const tag = envelope.slice(-32);
  const plaintext = fromUtf8(await otpDecrypt({ direction, offset, ciphertext, tag }, otpKey, otpTracker));
  $('#otp-result').textContent = plaintext;
  $('#otp-result').classList.add('has-result');
}, event.currentTarget));

document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
  transition(() => {
    document.querySelectorAll('.tab').forEach((item) => {
      const selected = item === tab;
      item.classList.toggle('is-active', selected);
      item.setAttribute('aria-selected', String(selected));
      item.tabIndex = selected ? 0 : -1;
    });
    document.querySelectorAll('.mode-panel').forEach((panel) => panel.classList.add('is-hidden'));
    $(`#${tab.dataset.mode}-panel`).classList.remove('is-hidden');
    const advanced = $('#advanced-panel');
    if (tab.dataset.mode !== 'live') {
      advanced?.classList.remove('is-hidden');
      $('#advanced-settings')?.setAttribute('aria-expanded', 'true');
    }
  });
}));

$('#advanced-settings').addEventListener('click', () => {
  const panel = $('#advanced-panel');
  const expanded = $('#advanced-settings').getAttribute('aria-expanded') === 'true';
  panel.classList.toggle('is-hidden', expanded);
  $('#advanced-settings').setAttribute('aria-expanded', String(!expanded));
});

$('#remember-session').addEventListener('change', async (event) => {
  if (!event.target.checked) {
    await deleteSessionState();
    sessionConfig = null;
    sessionPin = '';
    setSessionNote(t('sessionOffNote'));
  }
  refreshSessionOptions();
});
document.querySelectorAll('input[name="session-method"]').forEach((input) => input.addEventListener('change', refreshSessionOptions));
$('#session-pin').addEventListener('input', (event) => {
  const value = event.target.value.trim();
  const weak = /^(?:0+|1+|123456|12345678|987654|98765432|\d{6})$/.test(value);
  $('#pin-warning').classList.toggle('is-hidden', !weak);
});
$('#save-session-setting').addEventListener('click', () => run(async () => {
  if (!$('#remember-session').checked) {
    await deleteSessionState();
    sessionConfig = null;
    sessionPin = '';
    setSessionNote(t('sessionOffNote'));
    return;
  }
  const method = selectedSessionMethod();
  const pin = $('#session-pin').value.trim();
  if (method === 'pin' && (!/^\d{6,}$/.test(pin) || pin !== $('#session-pin-confirm').value.trim())) {
    throw new Error(t('pinMismatch'));
  }
  await deleteSessionState();
  sessionConfig = configureSessionPersistence(method, pin);
  sessionPin = method === 'pin' ? pin : '';
  try {
    if (sendRatchet && receiveRatchet) await persistEncryptedSession();
  } catch (error) {
    await deleteSessionState();
    sessionConfig = null;
    $('#remember-session').checked = false;
    refreshSessionOptions();
    throw new Error(method === 'browser' ? t('browserPersistenceUnavailable') : t('sessionSaveFailed'), { cause: error });
  }
  $('#session-pin').value = '';
  $('#session-pin-confirm').value = '';
  $('#pin-warning').classList.add('is-hidden');
  setSessionNote(t('sessionSaved'));
}), $('#save-session-setting'));

$('#restore-session').addEventListener('click', () => run(async () => {
  const button = $('#restore-session');
  const config = sessionConfig || getSessionConfig();
  const pin = $('#restore-pin').value.trim();
  if (!config) throw new Error(t('restoreFailed'));
  button.disabled = true;
  try {
    await restoreConfiguredSession(config, pin);
    updatePinFailure(config, 0);
    $('#restore-error').classList.add('is-hidden');
  } catch (error) {
    const attempts = (config.failedAttempts || 0) + 1;
    updatePinFailure(config, attempts);
    $('#restore-error').classList.remove('is-hidden');
    if (attempts >= 5) {
      await deleteSessionState();
      sessionConfig = null;
      $('#remember-session').checked = false;
      refreshSessionOptions();
      setHandshakeStage('choice');
      throw new Error(t('pinAttemptsExceeded'));
    }
    const delay = Math.min(8000, 500 * (2 ** (attempts - 1)));
    await new Promise((resolve) => setTimeout(resolve, delay));
    throw error;
  } finally {
    button.disabled = false;
  }
}), $('#restore-session'));

$('#forget-session').addEventListener('click', () => run(async () => {
  await deleteSessionState();
  sessionConfig = null;
  sessionPin = '';
  $('#remember-session').checked = false;
  refreshSessionOptions();
  setHandshakeStage('choice');
}));

document.querySelectorAll('.copy-button').forEach((button) => button.addEventListener('click', () => run(async () => {
  const target = document.getElementById(button.dataset.copy);
  if (!target.value) throw new Error(t('copyEmpty'));
  await navigator.clipboard.writeText(target.value);
  const original = button.textContent;
  button.textContent = t('copied');
  setTimeout(() => { button.textContent = original; }, 1300);
})));

$('#dismiss-banner').addEventListener('click', () => $('#privacy-banner').remove());
$('#locale-select').addEventListener('change', (event) => run(async () => {
  await setLocale(event.target.value);
  setTheme(document.documentElement.dataset.theme);
  setConnectionMode(connectionMode);
  renderConversation();
  populateContacts();
}));
$('#profile-name').addEventListener('input', updateProfileControls);
$('#offer-input').addEventListener('input', () => {
  const code = $('#offer-input').value.trim();
  if (!code) {
    showPeerPreview($('#offer-sender-preview'), '', 'senderWantsToChat');
    return;
  }
  void decodeHandshake(code).then((decoded) => {
    showPeerPreview($('#offer-sender-preview'), decoded.senderName, 'senderWantsToChat');
  }).catch(() => showPeerPreview($('#offer-sender-preview'), '', 'senderWantsToChat'));
});
$('#answer-input').addEventListener('input', () => {
  answerPeerConfirmed = false;
  showPeerPreview($('#answer-peer-preview'), '', 'youWillConnectTo');
});
$('#turn-server').value = localStorage.getItem(TURN_KEY) || '';
$('#save-turn-setting').addEventListener('click', (event) => run(async () => {
  const value = $('#turn-server').value.trim();
  if (value && !/^turns?:/iu.test(value)) throw new Error(t('turnInvalid'));
  if (value) localStorage.setItem(TURN_KEY, value);
  else localStorage.removeItem(TURN_KEY);
  $('#turn-settings-title').textContent = t('turnSaved');
}, event.currentTarget));
const existingAutoLock = autoLockConfig();
$('#auto-lock-enabled').checked = Boolean(existingAutoLock);
$('#auto-lock-fields').classList.toggle('is-hidden', !existingAutoLock);
if (existingAutoLock) $('#auto-lock-minutes').value = existingAutoLock.minutes;
$('#auto-lock-enabled').addEventListener('change', (event) => $('#auto-lock-fields').classList.toggle('is-hidden', !event.target.checked));
$('#save-auto-lock').addEventListener('click', (event) => run(async () => {
  if (!$('#auto-lock-enabled').checked) {
    localStorage.removeItem(AUTO_LOCK_KEY);
    clearTimeout(autoLockTimer);
    $('#auto-lock-fields').classList.add('is-hidden');
    return;
  }
  const pin = $('#auto-lock-pin').value.trim();
  if (!/^\d{6,}$/u.test(pin) || pin !== $('#auto-lock-pin-confirm').value.trim()) throw new Error(t('lockPinInvalid'));
  const minutes = Math.min(120, Math.max(1, Number.parseInt($('#auto-lock-minutes').value, 10) || 5));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const verifier = await autoLockVerifier(pin, salt);
  localStorage.setItem(AUTO_LOCK_KEY, JSON.stringify({ enabled: true, minutes, salt: toBase64(salt), verifier: toBase64(verifier) }));
  $('#auto-lock-pin').value = '';
  $('#auto-lock-pin-confirm').value = '';
  resetAutoLockTimer();
}, event.currentTarget));
$('#unlock-workspace').addEventListener('click', (event) => run(() => unlockWorkspace(), event.currentTarget));
$('#unlock-pin').addEventListener('keydown', (event) => { if (event.key === 'Enter') $('#unlock-workspace').click(); });
$('#chat-back').addEventListener('click', () => {
  stopQrScanner();
  setHandshakeStage('choice');
});
['pointerdown', 'keydown', 'touchstart'].forEach((eventName) => addEventListener(eventName, resetAutoLockTimer, { passive: true }));
$('#export-backup').addEventListener('click', (event) => run(async () => {
  const pin = $('#backup-pin').value.trim();
  const text = await encryptBackup(pin, backupSnapshot());
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  link.download = `anonymous-chat-backup-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}, event.currentTarget));
$('#import-backup').addEventListener('click', () => $('#backup-file').click());
$('#backup-file').addEventListener('change', (event) => run(async () => {
  const file = event.target.files[0];
  if (!file) return;
  const pin = $('#backup-pin').value.trim();
  const state = await decryptBackup(pin, await file.text());
  await deleteSessionState();
  sessionConfig = null;
  sessionPin = '';
  $('#remember-session').checked = false;
  refreshSessionOptions();
  restoreRatchets(state, '');
  for (const contact of state.contacts || []) {
    if (contact?.nickname) localStorage.setItem(`${STORAGE_PREFIX}conversation:${contact.nickname}`, JSON.stringify(contact));
  }
  populateContacts();
  event.target.value = '';
}, event.currentTarget));
$('#peer-safety-number').addEventListener('input', () => {
  $('#peer-safety-number').value = $('#peer-safety-number').value.toUpperCase().replace(/[^0-9A-F]/g, '').slice(0, 8);
  updateSecurityState();
});
$('#confirm-safety').addEventListener('click', () => {
  if (!sendRatchet || Date.now() - verificationStartedAt < 8000) return;
  const entered = $('#peer-safety-number').value.trim().toUpperCase();
  const expected = $('#safety-number').textContent.trim().toUpperCase();
  if (entered !== expected) {
    $('#verification-error').classList.remove('is-hidden');
    $('#verification-danger').classList.add('is-hidden');
    return;
  }
  $('#verification-error').classList.add('is-hidden');
  if (Date.now() - verificationStartedAt < 15_000) {
    $('#verification-delay').textContent = t('verificationTooFast');
    $('#verification-delay').classList.add('is-warning');
  }
  localSafetyConfirmed = true;
  if (transport?.channel?.readyState === 'open') transport.channel.send('verification_ack');
  completeSafetyIfMutual();
  updateSecurityState();
});
$('#retry-verification').addEventListener('click', () => beginSafetyVerification());
$('#restart-handshake').addEventListener('click', () => {
  disposeConversationSecrets();
  transport?.close();
  transport = null;
  setHandshakeStage('choice');
});
$('#reset-ratchet').addEventListener('click', () => {
  disposeConversationSecrets({ clearHistory: false });
  transport?.close();
  transport = null;
  $('#ratchet-recovery').classList.add('is-hidden');
  setHandshakeStage('choice');
});
$('#share-offer').addEventListener('click', (event) => run(() => shareHandshakeCode($('#offer-output').value.trim()), event.currentTarget));
$('#share-answer').addEventListener('click', (event) => run(() => shareHandshakeCode($('#answer-output').value.trim()), event.currentTarget));
$('#show-offer-qr').addEventListener('click', (event) => run(async () => renderHandshakeQr($('#offer-output').value.trim(), $('#offer-qr')), event.currentTarget));
$('#show-answer-qr').addEventListener('click', (event) => run(async () => renderHandshakeQr($('#answer-output').value.trim(), $('#answer-qr')), event.currentTarget));
$('#scan-qr').addEventListener('click', (event) => run(() => scanQr(), event.currentTarget));
$('#stop-qr').addEventListener('click', stopQrScanner);
addEventListener('pagehide', stopQrScanner);
$('#open-safety').addEventListener('click', () => {
  const panel = $('.chat-area > .security-panel');
  const open = !panel.classList.contains('is-hidden');
  panel.classList.toggle('is-hidden', open);
  $('#open-safety').setAttribute('aria-expanded', String(!open));
});
document.querySelectorAll('[data-open-app]').forEach((button) => button.addEventListener('click', () => setView('app')));
document.querySelectorAll('[data-home-link]').forEach((link) => link.addEventListener('click', (event) => {
  event.preventDefault();
  setView('landing');
}));
document.querySelectorAll('.theme-toggle').forEach((button) => button.addEventListener('click', () => {
  setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
}));
$('#message-list').addEventListener('click', (event) => {
  const button = event.target.closest('.message-copy');
  if (!button) return;
  run(async () => {
    await navigator.clipboard.writeText(button.dataset.messageText);
    button.textContent = t('copied');
    setTimeout(() => { button.textContent = t('copy'); }, 1300);
  }, button);
});
$('#clear-session').addEventListener('click', () => $('#clear-dialog').showModal());
$('#clear-confirm').addEventListener('change', (event) => { $('#clear-final').disabled = !event.target.checked; });
$('#clear-dialog').addEventListener('close', async () => {
  if ($('#clear-dialog').returnValue === 'default' && $('#clear-confirm').checked) {
    disposeConversationSecrets();
    otpKey?.fill(0);
    otpKey = null;
    transport?.close();
    transport = null;
    fallback = null;
    await deleteSessionState();
    localStorage.clear();
    location.reload();
  }
});

await initI18n();
setTheme(localStorage.getItem(THEME_KEY) || 'dark');
  $('#profile-name').value = profileName();
  updateProfileControls();
  updateStrength();
scrubLegacyConversationStorage();
populateContacts();
setConnectionMode('manual');
updateSecurityState();
setHandshakeStage('choice');
await initializeSessionPersistence();
try {
  if (!(await importHandshakeLink()) && location.hash === '#app') setView('app');
} catch (error) {
  history.replaceState(null, '', `${location.pathname}${location.search}`);
  reportError(error, t('openFailed'));
  setHandshakeStage('choice');
}
setupVisualEffects();
resetAutoLockTimer();

const observer = 'IntersectionObserver' in window && !prefersReducedMotion()
  ? new IntersectionObserver((entries, activeObserver) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-visible');
        activeObserver.unobserve(entry.target);
      }
    }, { rootMargin: '0px 0px -10% 0px', threshold: 0.08 })
  : null;
document.querySelectorAll('.reveal').forEach((element) => {
  if (observer) observer.observe(element);
  else element.classList.add('is-visible');
});
