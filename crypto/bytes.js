const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError('Expected byte data.');
}

export function utf8(value) {
  return encoder.encode(String(value));
}

export function fromUtf8(value) {
  return decoder.decode(asBytes(value));
}

export function concatBytes(...parts) {
  const arrays = parts.map(asBytes);
  const output = new Uint8Array(arrays.reduce((sum, item) => sum + item.length, 0));
  let offset = 0;
  for (const item of arrays) {
    output.set(item, offset);
    offset += item.length;
  }
  return output;
}

export function equalBytes(left, right) {
  const a = asBytes(left);
  const b = asBytes(right);
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

export function toBase64(value) {
  const bytes = asBytes(value);
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(value) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(value, 'base64'));
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function randomBytes(length) {
  if (!Number.isInteger(length) || length < 0) throw new RangeError('Invalid random byte length.');
  return crypto.getRandomValues(new Uint8Array(length));
}

export function zeroize(value) {
  if (value instanceof Uint8Array) value.fill(0);
}
