import { asBytes, concatBytes, utf8, fromUtf8, randomBytes } from './bytes.js';

export const PADDING_BUCKET = 128;
export const AES_IV_BYTES = 12;

export function padPlaintext(value, bucket = PADDING_BUCKET) {
  const plaintext = typeof value === 'string' ? utf8(value) : asBytes(value);
  if (plaintext.length > 65_535) throw new RangeError('Message is too large.');
  const paddedLength = Math.ceil((plaintext.length + 2) / bucket) * bucket;
  const output = new Uint8Array(paddedLength || bucket);
  new DataView(output.buffer).setUint16(0, plaintext.length, false);
  output.set(plaintext, 2);
  return output;
}

export function unpadPlaintext(value) {
  const padded = asBytes(value);
  if (padded.length < 2 || padded.length % PADDING_BUCKET !== 0) throw new Error('Invalid padded plaintext.');
  const length = new DataView(padded.buffer, padded.byteOffset, padded.byteLength).getUint16(0, false);
  if (length > padded.length - 2) throw new Error('Invalid plaintext length marker.');
  for (let index = length + 2; index < padded.length; index += 1) {
    if (padded[index] !== 0) throw new Error('Invalid plaintext padding.');
  }
  return padded.slice(2, length + 2);
}

async function importAesKey(key, usage) {
  const bytes = asBytes(key);
  if (bytes.length !== 32) throw new Error('AES-256 requires a 32-byte key.');
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, [usage]);
}

export async function encryptAesGcm(key, plaintext, options = {}) {
  if (Object.hasOwn(options, 'iv')) throw new Error('AES-GCM IV overrides are not allowed.');
  const iv = randomBytes(AES_IV_BYTES);
  const padded = padPlaintext(plaintext, options.bucket ?? PADDING_BUCKET);
  const cryptoKey = await importAesKey(key, 'encrypt');
  const params = { name: 'AES-GCM', iv, tagLength: 128 };
  if (options.additionalData) params.additionalData = asBytes(options.additionalData);
  const ciphertext = await crypto.subtle.encrypt(params, cryptoKey, padded);
  return { iv: new Uint8Array(iv), ciphertext: new Uint8Array(ciphertext) };
}

export async function decryptAesGcm(key, payload, options = {}) {
  try {
    const cryptoKey = await importAesKey(key, 'decrypt');
    const params = { name: 'AES-GCM', iv: asBytes(payload.iv), tagLength: 128 };
    if (options.additionalData) params.additionalData = asBytes(options.additionalData);
    const padded = await crypto.subtle.decrypt(params, cryptoKey, asBytes(payload.ciphertext));
    const plaintext = unpadPlaintext(new Uint8Array(padded));
    return options.asBytes ? plaintext : fromUtf8(plaintext);
  } catch (error) {
    throw new Error('Decryption failed: wrong key or modified data.', { cause: error });
  }
}

export function messageAad(sequence) {
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new RangeError('Invalid message sequence.');
  const number = new Uint8Array(8);
  new DataView(number.buffer).setBigUint64(0, BigInt(sequence), false);
  return concatBytes(utf8('anonymous-chat-message-v1'), number);
}
