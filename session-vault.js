const CONFIG_KEY = 'anonymous-chat:session-config';
const PIN_STATE_KEY = 'anonymous-chat:session-state';
const DB_NAME = 'anonymous-chat-session';
const DB_VERSION = 1;
const STORE_NAME = 'vault';
const STATE_VERSION = 1;
const PIN_ITERATIONS = 100_000;
const encoder = new TextEncoder();

function toBase64(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

function openDb() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB is unavailable.'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error ?? new Error('Could not open session storage.'));
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
  });
}

async function dbRead(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const request = transaction.objectStore(STORE_NAME).get(key);
    request.onerror = () => reject(request.error ?? new Error('Could not read session storage.'));
    request.onsuccess = () => resolve(request.result);
    transaction.oncomplete = () => db.close();
  });
}

async function dbWrite(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put(value, key);
    transaction.onerror = () => reject(transaction.error ?? new Error('Could not write session storage.'));
    transaction.oncomplete = () => { db.close(); resolve(); };
  });
}

async function dbDelete(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).delete(key);
    transaction.onerror = () => reject(transaction.error ?? new Error('Could not clear session storage.'));
    transaction.oncomplete = () => { db.close(); resolve(); };
  });
}

async function derivePinKey(pin, salt) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(pin.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({
    name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PIN_ITERATIONS,
  }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function encryptState(key, state) {
  const iv = randomBytes(12);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(`anonymous-chat-session-v${STATE_VERSION}`) },
    key,
    encoder.encode(JSON.stringify(state)),
  );
  return { version: STATE_VERSION, iv: toBase64(iv), ciphertext: toBase64(ciphertext) };
}

async function decryptState(key, payload) {
  if (!payload || payload.version !== STATE_VERSION || typeof payload.iv !== 'string' || typeof payload.ciphertext !== 'string') {
    throw new Error('Invalid persisted session.');
  }
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(payload.iv), additionalData: encoder.encode(`anonymous-chat-session-v${STATE_VERSION}`) },
    key,
    fromBase64(payload.ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

async function browserKey() {
  const saved = await dbRead('wrapping-key');
  if (saved) return saved;
  const extractable = false;
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, extractable, ['encrypt', 'decrypt']);
  await dbWrite('wrapping-key', key);
  return key;
}

export function getSessionConfig() {
  try {
    const value = JSON.parse(localStorage.getItem(CONFIG_KEY) ?? 'null');
    if (!value?.enabled || !['pin', 'browser'].includes(value.method)) return null;
    return value;
  } catch {
    return null;
  }
}

export function configureSessionPersistence(method, pin = '') {
  const config = { enabled: true, method };
  if (method === 'pin') {
    if (!/^\d{6,}$/.test(pin)) throw new Error('A PIN must contain at least 6 digits.');
    config.salt = toBase64(randomBytes(16));
    config.failedAttempts = 0;
  }
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  return config;
}

export function updatePinFailure(config, failedAttempts) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify({ ...config, failedAttempts }));
}

export async function saveSessionState(config, state, pin = '') {
  if (!config?.enabled) return;
  if (!state?.send?.chainKey || !state?.receive?.chainKey) throw new Error('A complete ratchet state is required.');
  const serializable = {
    version: STATE_VERSION,
    nickname: state.nickname,
    remotePublicKey: state.remotePublicKey,
    safetyNumber: state.safetyNumber,
    role: state.role,
    send: { direction: state.send.direction, position: state.send.position, chainKey: toBase64(state.send.chainKey) },
    receive: { direction: state.receive.direction, position: state.receive.position, chainKey: toBase64(state.receive.chainKey) },
  };
  if (config.method === 'browser') {
    const key = await browserKey();
    await dbWrite('encrypted-state', await encryptState(key, serializable));
    return;
  }
  const key = await derivePinKey(pin, fromBase64(config.salt));
  localStorage.setItem(PIN_STATE_KEY, JSON.stringify(await encryptState(key, serializable)));
}

export async function loadSessionState(config, pin = '') {
  if (!config?.enabled) return null;
  const payload = config.method === 'browser' ? await dbRead('encrypted-state') : JSON.parse(localStorage.getItem(PIN_STATE_KEY) ?? 'null');
  if (!payload) return null;
  const key = config.method === 'browser' ? await browserKey() : await derivePinKey(pin, fromBase64(config.salt));
  const state = await decryptState(key, payload);
  if (state.version !== STATE_VERSION || !state.send?.chainKey || !state.receive?.chainKey) throw new Error('Invalid persisted session.');
  return {
    ...state,
    send: { ...state.send, chainKey: fromBase64(state.send.chainKey) },
    receive: { ...state.receive, chainKey: fromBase64(state.receive.chainKey) },
  };
}

export async function hasStoredSessionState(config) {
  if (!config?.enabled) return false;
  if (config.method === 'browser') return Boolean(await dbRead('encrypted-state'));
  return Boolean(localStorage.getItem(PIN_STATE_KEY));
}

export async function deleteSessionState() {
  localStorage.removeItem(CONFIG_KEY);
  localStorage.removeItem(PIN_STATE_KEY);
  try {
    await dbDelete('encrypted-state');
    await dbDelete('wrapping-key');
  } catch {
    // IndexedDB may not exist in private or restricted browser contexts.
  }
}

export { PIN_ITERATIONS };
