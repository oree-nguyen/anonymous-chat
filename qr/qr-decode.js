import { createLayout, dataCoordinates, crc32 } from './qr-encode.js';

function readBytes(bits) {
  const output = new Uint8Array(Math.floor(bits.length / 8));
  for (let index = 0; index < output.length; index += 1) {
    let byte = 0;
    for (let bit = 0; bit < 8; bit += 1) byte = (byte << 1) | bits[index * 8 + bit];
    output[index] = byte;
  }
  return output;
}

export function decodeQr(code) {
  const size = Number(code?.size);
  const modules = code?.modules instanceof Uint8Array ? code.modules : Uint8Array.from(code?.modules ?? []);
  if (size < 21 || size > 57 || (size - 17) % 4 !== 0 || modules.length !== size * size) {
    throw new Error('Unsupported visual code dimensions.');
  }
  const { reserved } = createLayout(size);
  const bits = dataCoordinates(size, reserved).map(([row, column]) => modules[row * size + column] ^ ((row + column) % 2 === 0 ? 1 : 0));
  const bytes = readBytes(bits);
  if (bytes[0] !== 0x41 || bytes[1] !== 0x43 || bytes[2] !== 0x51 || bytes[3] !== 0x31) {
    throw new Error('Visual code marker is invalid.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint16(4, false);
  const expectedCrc = view.getUint32(6, false);
  if (length > bytes.length - 10) throw new Error('Visual code is truncated.');
  const payload = bytes.slice(10, 10 + length);
  if (crc32(payload) !== expectedCrc) throw new Error('Visual code checksum failed.');
  return payload;
}
