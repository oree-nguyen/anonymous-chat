import { asBytes, utf8 } from './bytes.js';

export const PBKDF2_ITERATIONS = 250_000;
export const MIN_PASSPHRASE_BITS = 60;
export const ROOT_INFO = 'anonymous-chat-root';

export async function hkdf(inputKeyMaterial, info, options = {}) {
  const material = await crypto.subtle.importKey('raw', asBytes(inputKeyMaterial), 'HKDF', false, ['deriveBits']);
  const salt = options.salt ? asBytes(options.salt) : new Uint8Array(32);
  const bits = await crypto.subtle.deriveBits({
    name: 'HKDF',
    hash: 'SHA-256',
    salt,
    info: typeof info === 'string' ? utf8(info) : asBytes(info),
  }, material, options.length ?? 256);
  return new Uint8Array(bits);
}

export async function derivePassphraseKey(passphrase, salt) {
  if (typeof passphrase !== 'string' || !passphrase) throw new Error('Passphrase is required.');
  const material = await crypto.subtle.importKey('raw', utf8(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({
    name: 'PBKDF2',
    hash: 'SHA-256',
    salt: asBytes(salt),
    iterations: PBKDF2_ITERATIONS,
  }, material, 256);
  return new Uint8Array(bits);
}

export async function passphraseRootKey(passphrase, salt) {
  const stretched = await derivePassphraseKey(passphrase, salt);
  try {
    return await hkdf(stretched, ROOT_INFO);
  } finally {
    stretched.fill(0);
  }
}

const COMMON_WEAK = new Set([
  '123456', '12345678', 'password', 'password1', 'qwerty', 'letmein', 'welcome',
  'iloveyou', 'admin', 'anonymous', 'secret', 'matkhau', 'xinchaoban',
]);

export function estimatePassphraseStrength(passphrase) {
  const normalized = String(passphrase ?? '').normalize('NFKC').trim();
  const lower = normalized.toLocaleLowerCase('en');
  const words = normalized.split(/\s+/u).filter(Boolean);
  const isDate = /^(?:19|20)?\d{2}[-/.]?\d{1,2}[-/.]?\d{1,2}$/u.test(normalized) || /^\d{6,8}$/u.test(normalized);
  const unique = new Set([...normalized]).size;
  let pool = 0;
  if (/[a-z]/u.test(normalized)) pool += 26;
  if (/[A-Z]/u.test(normalized)) pool += 26;
  if (/\d/u.test(normalized)) pool += 10;
  if (/[^\p{L}\p{N}\s]/u.test(normalized)) pool += 32;
  if (/[^\x00-\x7F]/u.test(normalized)) pool += 80;
  const characterBits = pool > 0 ? Math.log2(pool) * normalized.length : 0;
  const dicewareBits = words.length >= 4 && words.every((word) => word.length >= 3)
    ? words.length * Math.log2(7776)
    : 0;
  const entropy = Math.round(Math.max(characterBits, dicewareBits));
  const obviousPattern = COMMON_WEAK.has(lower) || isDate || /(.)\1{4,}/u.test(normalized) || unique < 4;
  const accepted = !obviousPattern && (entropy >= MIN_PASSPHRASE_BITS || (words.length >= 5 && new Set(words.map((word) => word.toLowerCase())).size === words.length));
  return {
    accepted,
    entropy,
    reason: obviousPattern
      ? 'This passphrase is commonly guessed or follows an obvious pattern.'
      : accepted
        ? 'Passphrase strength is acceptable.'
        : 'Use 5 or 6 unrelated random words, or a longer unique passphrase.',
  };
}
