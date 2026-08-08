import { fromBase64 } from '../crypto/bytes.js';

const PREFIX = 'anonymous-chat:1:';

function moduleChecksum(modules) {
  let hash = 2166136261;
  for (const value of modules) hash = Math.imul(hash ^ value, 16777619) >>> 0;
  return hash;
}

function decodeText(value) {
  if (typeof value !== 'string' || !value.startsWith(PREFIX)) throw new Error('QR code is not an anonymous-chat handshake.');
  const encoded = value.slice(PREFIX.length).replaceAll('-', '+').replaceAll('_', '/');
  return fromBase64(encoded + '='.repeat((4 - (encoded.length % 4)) % 4));
}

export function decodeQr(code) {
  if (code?.modules && code.moduleChecksum !== undefined && moduleChecksum(code.modules) !== code.moduleChecksum) throw new Error('QR module checksum failed.');
  if (typeof code?.data === 'string') return decodeText(code.data);
  throw new Error('Provide a QR scan result from the camera.');
}

export function decodeQrImageData(imageData, width, height) {
  if (typeof jsQR !== 'function') throw new Error('QR camera decoder is unavailable.');
  const result = jsQR(imageData, width, height, { inversionAttempts: 'attemptBoth' });
  if (!result) throw new Error('No QR code was found in this image.');
  return decodeText(result.data);
}
