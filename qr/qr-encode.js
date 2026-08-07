import { asBytes, concatBytes } from '../crypto/bytes.js';

const MAGIC = Uint8Array.of(0x41, 0x43, 0x51, 0x31);

export function crc32(value) {
  let crc = 0xFFFFFFFF;
  for (const byte of asBytes(value)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function marker(matrix, reserved, size, row, column) {
  for (let y = -1; y <= 7; y += 1) {
    for (let x = -1; x <= 7; x += 1) {
      const targetY = row + y;
      const targetX = column + x;
      if (targetY < 0 || targetX < 0 || targetY >= size || targetX >= size) continue;
      const index = targetY * size + targetX;
      reserved[index] = 1;
      matrix[index] = x >= 0 && x <= 6 && y >= 0 && y <= 6
        && (x === 0 || x === 6 || y === 0 || y === 6 || (x >= 2 && x <= 4 && y >= 2 && y <= 4)) ? 1 : 0;
    }
  }
}

export function createLayout(size) {
  const matrix = new Uint8Array(size * size);
  const reserved = new Uint8Array(size * size);
  marker(matrix, reserved, size, 0, 0);
  marker(matrix, reserved, size, 0, size - 7);
  marker(matrix, reserved, size, size - 7, 0);
  for (let index = 8; index < size - 8; index += 1) {
    matrix[6 * size + index] = index % 2 === 0 ? 1 : 0;
    matrix[index * size + 6] = index % 2 === 0 ? 1 : 0;
    reserved[6 * size + index] = 1;
    reserved[index * size + 6] = 1;
  }
  return { matrix, reserved };
}

export function dataCoordinates(size, reserved) {
  const coordinates = [];
  let upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right -= 1;
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (let offset = 0; offset < 2; offset += 1) {
        const column = right - offset;
        if (!reserved[row * size + column]) coordinates.push([row, column]);
      }
    }
    upward = !upward;
  }
  return coordinates;
}

function envelope(data) {
  const bytes = asBytes(data);
  if (bytes.length > 65_535) throw new RangeError('Visual code data is too large.');
  const metadata = new Uint8Array(6);
  const view = new DataView(metadata.buffer);
  view.setUint16(0, bytes.length, false);
  view.setUint32(2, crc32(bytes), false);
  return concatBytes(MAGIC, metadata, bytes);
}

export function encodeQr(data) {
  const payload = envelope(data);
  for (let version = 1; version <= 10; version += 1) {
    const size = 17 + version * 4;
    const { matrix, reserved } = createLayout(size);
    const coordinates = dataCoordinates(size, reserved);
    if (coordinates.length < payload.length * 8) continue;
    let bitIndex = 0;
    for (const [row, column] of coordinates) {
      const bit = bitIndex < payload.length * 8
        ? (payload[Math.floor(bitIndex / 8)] >> (7 - (bitIndex % 8))) & 1
        : 0;
      matrix[row * size + column] = bit ^ ((row + column) % 2 === 0 ? 1 : 0);
      bitIndex += 1;
    }
    return { version, size, modules: matrix };
  }
  throw new Error('Data exceeds the supported visual code capacity (versions 1-10).');
}

export function drawQrToCanvas(code, canvas, scale = 8, quietZone = 4) {
  const dimension = (code.size + quietZone * 2) * scale;
  canvas.width = dimension;
  canvas.height = dimension;
  const context = canvas.getContext('2d', { alpha: false });
  context.fillStyle = '#f8faf9';
  context.fillRect(0, 0, dimension, dimension);
  context.fillStyle = '#14251d';
  for (let row = 0; row < code.size; row += 1) {
    for (let column = 0; column < code.size; column += 1) {
      if (code.modules[row * code.size + column]) {
        context.fillRect((column + quietZone) * scale, (row + quietZone) * scale, scale, scale);
      }
    }
  }
}
