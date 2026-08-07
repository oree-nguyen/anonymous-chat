import { initI18n, setLocale, t } from './i18n.js';
import { estimatePassphraseStrength } from './crypto/kdf.js';
import { encryptPassphraseMessage, decryptPassphraseMessage, encryptRatchetMessage, decryptRatchetMessage } from './crypto/message.js';
import { packPayload, unpackPayload } from './crypto/emoji-codec.js';
import { createRatchetState, RATCHET_DIRECTIONS } from './crypto/ratchet.js';
import { RatchetState } from './crypto/ratchet.js';
import { fromUtf8, concatBytes, zeroize } from './crypto/bytes.js';
import { generateOtpKey, otpEncrypt, otpDecrypt, OtpUsageTracker, OTP_DIRECTIONS, otpDirectionCode, otpDirectionFromCode } from './crypto/otp.js';
import { PeerTransport } from './webrtc/peer.js';
import { decodeHandshake } from './webrtc/handshake.js';
import { FallbackController } from './webrtc/fallback.js';
import { roleForPublicKeys } from './crypto/ecdh.js';
import { configureSessionPersistence, deleteSessionState, getSessionConfig, hasStoredSessionState, loadSessionState, saveSessionState, updatePinFailure } from './session-vault.js';

const $ = (selector) => document.querySelector(selector);
const STORAGE_PREFIX = 'anonymous-chat:';
const THEME_KEY = `${STORAGE_PREFIX}theme`;
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
    reportError(error, t('openFailed'));
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
  confirm.disabled = !sendRatchet || safetyConfirmed;
  confirm.textContent = safetyConfirmed ? t('verifiedState') : t('confirmMatch');
  message.placeholder = safetyConfirmed ? t('messagePlaceholder') : t('verifyBeforeWriting');
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
  instance.addEventListener('message', (event) => {
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
  safetyConfirmed = false;
  updateSecurityState();
  renderConversation();
  persistConversation();
  if (!deferVerification) enterVerifyingStage();
}

function disposeConversationSecrets() {
  sendRatchet?.dispose();
  receiveRatchet?.dispose();
  sendRatchet = null;
  receiveRatchet = null;
  for (const message of conversationMessages) message.text = '';
  conversationMessages = [];
  safetyConfirmed = false;
  updateSecurityState();
}

function freshTransport() {
  transport?.close();
  transport = new PeerTransport();
  bindTransport(transport);
  return transport;
}

$('#choose-start').addEventListener('click', () => {
  handshakeRole = 'start';
  setHandshakeStage('a-enter');
  $('#contact-name').focus();
});

$('#choose-join').addEventListener('click', () => {
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
  const code = await peer.createOffer();
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
  const decoded = decodeHandshake(code);
  const reconnect = decoded.kind === 'reconnect-offer';
  if (reconnect && !transport) throw new Error(t('reconnectSessionRequired'));
  if (!reconnect) {
    disposeConversationSecrets();
    renderConversation([]);
  }
  setConnectionMode('connecting');
  const peer = reconnect && transport ? transport : freshTransport();
  const answer = await peer.acceptOffer(code, { reconnect });
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
  const decoded = decodeHandshake(code);
  const reconnect = decoded.kind === 'reconnect-answer';
  await transport.acceptAnswer(code, { reconnect });
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
  const code = await transport.createOffer({ reconnect: true });
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
  return result;
}

$('#passphrase').addEventListener('input', updateStrength);
$('#manual-encrypt').addEventListener('click', (event) => run(async () => {
  const strength = updateStrength();
  if (!strength.accepted) throw new Error(t('passphraseWeak'));
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
$('#confirm-safety').addEventListener('click', () => {
  if (!sendRatchet) return;
  safetyConfirmed = true;
  updateSecurityState();
  enterChatting();
});
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
scrubLegacyConversationStorage();
populateContacts();
setConnectionMode('manual');
updateSecurityState();
setHandshakeStage('choice');
await initializeSessionPersistence();
if (location.hash === '#app') setView('app');
setupVisualEffects();

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
