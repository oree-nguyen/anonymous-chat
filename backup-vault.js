const ITERATIONS = 100_000;
const VERSION = 1;
const encoder = new TextEncoder();

function toBase64(value) {
  let binary = '';
  for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

async function deriveKey(pin, salt) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(pin.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encryptBackup(pin, state) {
  if (!/^\d{6,}$/u.test(pin)) throw new Error('A backup PIN must contain at least 6 digits.');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pin, salt);
  const serializable = { ...state, send: { ...state.send, chainKey: toBase64(state.send.chainKey) }, receive: { ...state.receive, chainKey: toBase64(state.receive.chainKey) } };
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(`anonymous-chat-backup-v${VERSION}`) }, key, encoder.encode(JSON.stringify({ version: VERSION, ...serializable })));
  return JSON.stringify({ version: VERSION, kdf: 'PBKDF2-SHA256', iterations: ITERATIONS, salt: toBase64(salt), iv: toBase64(iv), ciphertext: toBase64(ciphertext) });
}

export async function decryptBackup(pin, text) {
  const envelope = JSON.parse(text);
  if (envelope?.version !== VERSION || envelope.iterations !== ITERATIONS || envelope.kdf !== 'PBKDF2-SHA256') throw new Error('Unsupported backup format.');
  const key = await deriveKey(pin, fromBase64(envelope.salt));
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(envelope.iv), additionalData: encoder.encode(`anonymous-chat-backup-v${VERSION}`) }, key, fromBase64(envelope.ciphertext));
  const state = JSON.parse(new TextDecoder().decode(plaintext));
  if (state.version !== VERSION || !state.send?.chainKey || !state.receive?.chainKey) throw new Error('Backup is incomplete or damaged.');
  return { ...state, send: { ...state.send, chainKey: fromBase64(state.send.chainKey) }, receive: { ...state.receive, chainKey: fromBase64(state.receive.chainKey) } };
}

export { ITERATIONS };
