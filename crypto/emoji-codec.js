import { EMOJI_TABLE } from './emoji-table.js';
import { asBytes, concatBytes } from './bytes.js';

export const BITS_PER_CHAR = Math.log2(EMOJI_TABLE.length);
if (!Number.isInteger(BITS_PER_CHAR)) throw new Error('Emoji table size must be a power of two.');

const EMOJI_INDEX = new Map(EMOJI_TABLE.map((character, index) => [character, index]));

export function crc32(value) {
  let crc = 0xFFFFFFFF;
  for (const byte of asBytes(value)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

export function bufToEmoji(value) {
  const bytes = asBytes(value);
  let buffer = 0;
  let bitCount = 0;
  let output = '';
  for (const byte of bytes) {
    buffer = buffer * 256 + byte;
    bitCount += 8;
    while (bitCount >= BITS_PER_CHAR) {
      bitCount -= BITS_PER_CHAR;
      const divisor = 2 ** bitCount;
      const index = Math.floor(buffer / divisor);
      output += EMOJI_TABLE[index];
      buffer %= divisor;
    }
  }
  if (bitCount > 0) output += EMOJI_TABLE[buffer * (2 ** (BITS_PER_CHAR - bitCount))];
  return output;
}

export function emojiToBuf(value, byteLength) {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) throw new RangeError('Invalid expected byte length.');
  const symbols = [...String(value).replace(/\s/gu, '')];
  const expectedSymbols = Math.ceil((byteLength * 8) / BITS_PER_CHAR);
  if (symbols.length !== expectedSymbols) throw new Error('Emoji payload has a non-canonical length.');
  let buffer = 0;
  let bitCount = 0;
  const output = [];
  for (const symbol of symbols) {
    const index = EMOJI_INDEX.get(symbol);
    if (index === undefined) throw new Error(`Invalid emoji symbol at position ${output.length + 1}.`);
    buffer = buffer * (2 ** BITS_PER_CHAR) + index;
    bitCount += BITS_PER_CHAR;
    while (bitCount >= 8 && output.length < byteLength) {
      bitCount -= 8;
      const divisor = 2 ** bitCount;
      output.push(Math.floor(buffer / divisor));
      buffer %= divisor;
    }
  }
  if (output.length !== byteLength) throw new Error('Emoji payload is truncated or has the wrong length.');
  if (buffer !== 0) throw new Error('Emoji payload has non-zero trailing bits.');
  return Uint8Array.from(output);
}

export function packPayload(value) {
  const bytes = asBytes(value);
  if (bytes.length > 65_531) throw new RangeError('Payload exceeds the 65,535-byte emoji envelope limit.');
  const checksum = new Uint8Array(4);
  new DataView(checksum.buffer).setUint32(0, crc32(bytes), false);
  const length = new Uint8Array(2);
  new DataView(length.buffer).setUint16(0, bytes.length + checksum.length, false);
  return bufToEmoji(concatBytes(length, bytes, checksum));
}

export function unpackPayload(value) {
  const symbols = [...String(value).replace(/\s/gu, '')];
  if (symbols.length < Math.ceil(16 / BITS_PER_CHAR)) throw new Error('Emoji payload is too short.');
  let prefixBuffer = 0;
  let prefixBits = 0;
  for (const symbol of symbols.slice(0, Math.ceil(16 / BITS_PER_CHAR))) {
    const index = EMOJI_INDEX.get(symbol);
    if (index === undefined) throw new Error('Emoji payload contains an invalid symbol.');
    prefixBuffer = prefixBuffer * (2 ** BITS_PER_CHAR) + index;
    prefixBits += BITS_PER_CHAR;
  }
  const length = Math.floor(prefixBuffer / (2 ** (prefixBits - 16)));
  const totalBytes = length + 2;
  const requiredSymbols = Math.ceil((totalBytes * 8) / BITS_PER_CHAR);
  if (symbols.length !== requiredSymbols) throw new Error('Emoji payload length does not match its header.');
  const packed = emojiToBuf(symbols.join(''), totalBytes).slice(2);
  if (packed.length < 4) throw new Error('Emoji payload checksum is missing.');
  const payload = packed.slice(0, -4);
  const expected = new DataView(packed.buffer, packed.byteOffset + packed.length - 4, 4).getUint32(0, false);
  if (crc32(payload) !== expected) throw new Error('Emoji payload checksum failed.');
  return payload;
}
