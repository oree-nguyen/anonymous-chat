import { initI18n, setLocale, t } from './i18n.js';
import { estimatePassphraseStrength } from './crypto/kdf.js';
import { encryptPassphraseMessage, decryptPassphraseMessage, encryptRatchetMessage, decryptRatchetMessage } from './crypto/message.js';
import { packPayload, unpackPayload } from './crypto/emoji-codec.js';
import { createRatchetState, RATCHET_DIRECTIONS } from './crypto/ratchet.js';
import { fromUtf8, concatBytes } from './crypto/bytes.js';
import { generateOtpKey, otpEncrypt, otpDecrypt, OtpUsageTracker, OTP_DIRECTIONS, otpDirectionCode, otpDirectionFromCode } from './crypto/otp.js';
import { PeerTransport } from './webrtc/peer.js';
import { decodeHandshake } from './webrtc/handshake.js';
import { FallbackController } from './webrtc/fallback.js';
import { roleForPublicKeys } from './crypto/ecdh.js';

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

function setTheme(theme) {
  const selected = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = selected;
  localStorage.setItem(THEME_KEY, selected);
  document.querySelectorAll('.theme-toggle').forEach((button) => {
    button.setAttribute('aria-pressed', String(selected === 'light'));
    button.title = selected === 'light' ? t('switchDark') : t('switchLight');
  });
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
  instance.addEventListener('message', (event) => {
    runDecryption(async () => {
      const plaintext = await decryptRatchetMessage(receiveRatchet, new Uint8Array(event.detail));
      appendMessage(plaintext, false);
      persistConversation();
    });
  });
  instance.addEventListener('channelerror', () => reportError(new Error(t('directChannelError'))));
}

async function initializeConversation() {
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
  $('#chat-area').classList.remove('is-hidden');
  $('#reconnect').disabled = false;
  $('#safety-number').textContent = await transport.getSafetyNumber();
  $('#safety-number').title = t('verifySafety');
  safetyConfirmed = false;
  updateSecurityState();
  renderConversation();
  persistConversation();
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

$('#create-offer').addEventListener('click', (event) => run(async () => {
  setConnectionMode('connecting');
  disposeConversationSecrets();
  renderConversation([]);
  const peer = freshTransport();
  const code = await peer.createOffer();
  $('#offer-output').value = code;
  $('#offer-output-block').classList.remove('is-hidden');
  $('#answer-input-block').classList.remove('is-hidden');
  $('#connection-detail').textContent = t('offerReady');
}, event.currentTarget));

$('#create-answer').addEventListener('click', (event) => run(async () => {
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
  if (!sendRatchet) await initializeConversation();
  else if (peer.rootKey) {
    peer.rootKey.fill(0);
    peer.rootKey = null;
  }
}, event.currentTarget));

$('#accept-answer').addEventListener('click', (event) => run(async () => {
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
}, event.currentTarget));

$('#reconnect').addEventListener('click', (event) => run(async () => {
  if (!transport || !sendRatchet) throw new Error(t('conversationMissing'));
  setConnectionMode('connecting');
  const code = await transport.createOffer({ reconnect: true });
  $('#offer-output').value = code;
  $('#offer-output-block').classList.remove('is-hidden');
  $('#answer-input-block').classList.remove('is-hidden');
  $('#connection-detail').textContent = t('reconnectReady');
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
  });
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
  $('#chat-message').focus();
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
$('#clear-dialog').addEventListener('close', () => {
  if ($('#clear-dialog').returnValue === 'default' && $('#clear-confirm').checked) {
    disposeConversationSecrets();
    otpKey?.fill(0);
    otpKey = null;
    transport?.close();
    transport = null;
    fallback = null;
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
if (location.hash === '#app') setView('app');

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
