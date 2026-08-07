import { asBytes, concatBytes } from './bytes.js';
import { hkdf, ROOT_INFO } from './kdf.js';

export async function generateEcdhKeyPair() {
  return crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
}

export async function exportPublicKey(publicKey) {
  return new Uint8Array(await crypto.subtle.exportKey('raw', publicKey));
}

export async function importPublicKey(raw) {
  return crypto.subtle.importKey('raw', asBytes(raw), { name: 'ECDH', namedCurve: 'P-256' }, true, []);
}

export async function deriveRootKey(privateKey, remotePublicKey) {
  const publicKey = remotePublicKey instanceof CryptoKey ? remotePublicKey : await importPublicKey(remotePublicKey);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256));
  try {
    return await hkdf(secret, ROOT_INFO);
  } finally {
    secret.fill(0);
  }
}

export function comparePublicKeys(a, b) {
  const left = asBytes(a);
  const right = asBytes(b);
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.length - right.length;
}

export async function safetyNumber(publicKeyA, publicKeyB) {
  const a = asBytes(publicKeyA);
  const b = asBytes(publicKeyB);
  const ordered = comparePublicKeys(a, b) <= 0 ? concatBytes(a, b) : concatBytes(b, a);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', ordered));
  return [...digest.slice(0, 4)].map((byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
}

export function roleForPublicKeys(localPublicKey, remotePublicKey) {
  const comparison = comparePublicKeys(localPublicKey, remotePublicKey);
  if (comparison === 0) throw new Error('Local and remote public keys must be different.');
  return comparison < 0 ? 'A' : 'B';
}
