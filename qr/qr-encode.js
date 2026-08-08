import { asBytes, toBase64 } from '../crypto/bytes.js';

const PREFIX = 'anonymous-chat:1:';
let qrFactory = globalThis.qrcode;

function moduleChecksum(modules) {
  let hash = 2166136261;
  for (const value of modules) hash = Math.imul(hash ^ value, 16777619) >>> 0;
  return hash;
}

if (!qrFactory && typeof process !== 'undefined' && process.versions?.node) {
  const [{ readFile }, { runInNewContext }] = await Promise.all([import('node:fs/promises'), import('node:vm')]);
  const source = await readFile(new URL('./vendor/qrcode-generator.js', import.meta.url), 'utf8');
  const context = {};
  runInNewContext(source, context);
  qrFactory = context.qrcode;
}

function payloadText(data) {
  return `${PREFIX}${toBase64(asBytes(data)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')}`;
}

export function encodeQr(data) {
  if (typeof qrFactory !== 'function') throw new Error('QR generator is unavailable.');
  const value = payloadText(data);
  const generator = qrFactory(0, 'M');
  generator.addData(value, 'Byte');
  generator.make();
  const size = generator.getModuleCount();
  const modules = new Uint8Array(size * size);
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) modules[row * size + column] = generator.isDark(row, column) ? 1 : 0;
  }
  return { version: 0, size, modules, moduleChecksum: moduleChecksum(modules), data: value };
}

export function drawQrToCanvas(code, canvas, scale = 6, quietZone = 4) {
  const dimension = (code.size + quietZone * 2) * scale;
  canvas.width = dimension;
  canvas.height = dimension;
  const context = canvas.getContext('2d', { alpha: false });
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, dimension, dimension);
  context.fillStyle = '#0a0a0c';
  for (let row = 0; row < code.size; row += 1) {
    for (let column = 0; column < code.size; column += 1) {
      if (code.modules[row * code.size + column]) context.fillRect((column + quietZone) * scale, (row + quietZone) * scale, scale, scale);
    }
  }
}
