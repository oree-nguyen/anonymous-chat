import { asBytes, concatBytes, utf8, zeroize } from './bytes.js';
import { padPlaintext, unpadPlaintext, PADDING_BUCKET } from './aes.js';

export const OTP_DIRECTIONS = Object.freeze({
  A_TO_B: 'A-to-B',
  B_TO_A: 'B-to-A',
});
export const OTP_HMAC_KEY_BYTES = 32;
export const OTP_TAG_BYTES = 32;
export const OTP_RESERVED_BYTES = OTP_HMAC_KEY_BYTES * 2;
export const OTP_MIN_KEY_BYTES = OTP_RESERVED_BYTES + (PADDING_BUCKET * 2);

const DIRECTION_CODES = new Map([
  [OTP_DIRECTIONS.A_TO_B, 1],
  [OTP_DIRECTIONS.B_TO_A, 2],
]);

function validateDirection(direction) {
  if (!DIRECTION_CODES.has(direction)) throw new Error('OTP direction A-to-B or B-to-A is required.');
  return direction;
}

export function otpDirectionCode(direction) {
  return DIRECTION_CODES.get(validateDirection(direction));
}

export function otpDirectionFromCode(code) {
  for (const [direction, value] of DIRECTION_CODES) {
    if (value === code) return direction;
  }
  throw new Error('OTP payload has an invalid direction.');
}

function regionFor(keyFile, direction) {
  const key = asBytes(keyFile);
  validateDirection(direction);
  if (key.length < OTP_MIN_KEY_BYTES) {
    throw new Error(`OTP key must contain at least ${OTP_MIN_KEY_BYTES} bytes for authentication and both directions.`);
  }
  const dataBytes = key.length - OTP_RESERVED_BYTES;
  const firstLength = Math.floor(dataBytes / 2);
  if (direction === OTP_DIRECTIONS.A_TO_B) {
    return { start: OTP_RESERVED_BYTES, end: OTP_RESERVED_BYTES + firstLength, hmacStart: 0 };
  }
  return { start: OTP_RESERVED_BYTES + firstLength, end: key.length, hmacStart: OTP_HMAC_KEY_BYTES };
}

function offsetBytes(offset) {
  const output = new Uint8Array(8);
  new DataView(output.buffer).setBigUint64(0, BigInt(offset), false);
  return output;
}

function authenticatedData(direction, offset, ciphertext) {
  return concatBytes(
    utf8('anonymous-chat-otp-v2'),
    Uint8Array.of(DIRECTION_CODES.get(validateDirection(direction))),
    offsetBytes(offset),
    asBytes(ciphertext),
  );
}

async function importHmacKey(keyFile, direction, usage) {
  const key = asBytes(keyFile);
  const { hmacStart } = regionFor(key, direction);
  const material = key.slice(hmacStart, hmacStart + OTP_HMAC_KEY_BYTES);
  try {
    return await crypto.subtle.importKey('raw', material, { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
  } finally {
    zeroize(material);
  }
}

async function signOtp(keyFile, direction, offset, ciphertext) {
  const key = await importHmacKey(keyFile, direction, 'sign');
  const tag = await crypto.subtle.sign('HMAC', key, authenticatedData(direction, offset, ciphertext));
  return new Uint8Array(tag);
}

async function verifyOtp(keyFile, payload) {
  const tag = asBytes(payload.tag);
  if (tag.length !== OTP_TAG_BYTES) throw new Error('OTP authentication failed.');
  const key = await importHmacKey(keyFile, payload.direction, 'verify');
  const valid = await crypto.subtle.verify('HMAC', key, tag, authenticatedData(payload.direction, payload.offset, payload.ciphertext));
  if (!valid) throw new Error('OTP authentication failed.');
}

export async function keyFileId(keyFile) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', asBytes(keyFile)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function generateOtpKey(length) {
  if (!Number.isSafeInteger(length) || length < OTP_MIN_KEY_BYTES) {
    throw new RangeError(`OTP key must contain at least ${OTP_MIN_KEY_BYTES} bytes.`);
  }
  const output = new Uint8Array(length);
  for (let offset = 0; offset < length; offset += 65_536) {
    crypto.getRandomValues(output.subarray(offset, Math.min(offset + 65_536, length)));
  }
  return output;
}

export function xorOtp(input, keyFile, offset = 0) {
  const bytes = asBytes(input);
  const key = asBytes(keyFile);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError('Invalid OTP offset.');
  if (offset + bytes.length > key.length) throw new Error('OTP key file is shorter than the required region.');
  return Uint8Array.from(bytes, (byte, index) => byte ^ key[offset + index]);
}

export class OtpUsageTracker {
  constructor(storage = null, prefix = 'anonymous-chat:otp:') {
    this.storage = storage;
    this.prefix = prefix;
    this.memory = new Map();
  }

  storageKey(fileId, direction) {
    return `${this.prefix}${fileId}:${validateDirection(direction)}`;
  }

  getOffset(fileId, direction) {
    const key = this.storageKey(fileId, direction);
    const raw = this.storage?.getItem(key);
    const value = raw === null || raw === undefined ? (this.memory.get(key) ?? 0) : Number(raw);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Stored OTP offset data is corrupted.');
    return value;
  }

  reserve(fileId, direction, requestedOffset, length, capacity = Number.MAX_SAFE_INTEGER) {
    const key = this.storageKey(fileId, direction);
    const current = this.getOffset(fileId, direction);
    if (!Number.isSafeInteger(requestedOffset) || requestedOffset < 0 || requestedOffset !== current) {
      throw new Error('OTP region reuse or offset rollback was refused.');
    }
    if (!Number.isSafeInteger(length) || length < 0 || current + length > capacity) {
      throw new Error('OTP key file does not have enough unused bytes in this direction.');
    }
    const next = current + length;
    if (this.storage) this.storage.setItem(key, String(next));
    this.memory.set(key, next);
    return next;
  }
}

export async function otpEncrypt(plaintext, keyFile, tracker, direction, requestedOffset) {
  if (!(tracker instanceof OtpUsageTracker)) throw new TypeError('An OtpUsageTracker is required.');
  const key = asBytes(keyFile);
  const selectedDirection = validateDirection(direction);
  const region = regionFor(key, selectedDirection);
  const capacity = region.end - region.start;
  const fileId = await keyFileId(key);
  const relativeOffset = requestedOffset ?? tracker.getOffset(fileId, selectedDirection);
  const padded = padPlaintext(plaintext);
  if (relativeOffset + padded.length > capacity) {
    zeroize(padded);
    throw new Error('OTP key file does not have enough unused bytes in this direction.');
  }
  const offset = region.start + relativeOffset;
  try {
    const ciphertext = xorOtp(padded, key, offset);
    const tag = await signOtp(key, selectedDirection, offset, ciphertext);
    tracker.reserve(fileId, selectedDirection, relativeOffset, padded.length, capacity);
    return { fileId, direction: selectedDirection, offset, ciphertext, tag };
  } finally {
    zeroize(padded);
  }
}

export async function otpDecrypt(payload, keyFile, tracker = null) {
  const key = asBytes(keyFile);
  const direction = validateDirection(payload.direction);
  const region = regionFor(key, direction);
  const ciphertext = asBytes(payload.ciphertext);
  if (!Number.isSafeInteger(payload.offset) || payload.offset < region.start || payload.offset + ciphertext.length > region.end) {
    throw new Error('OTP payload is outside its assigned direction region.');
  }
  await verifyOtp(key, { ...payload, direction, ciphertext });
  const padded = xorOtp(ciphertext, key, payload.offset);
  try {
    const plaintext = unpadPlaintext(padded);
    if (tracker) {
      const fileId = await keyFileId(key);
      const relativeOffset = payload.offset - region.start;
      tracker.reserve(fileId, direction, relativeOffset, ciphertext.length, region.end - region.start);
    }
    return plaintext;
  } finally {
    zeroize(padded);
  }
}
