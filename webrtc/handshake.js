import { utf8, fromUtf8, toBase64, fromBase64, concatBytes } from '../crypto/bytes.js';
import { packPayload, unpackPayload } from '../crypto/emoji-codec.js';

const VERSION = 2;
const KINDS = new Set(['offer', 'answer', 'reconnect-offer', 'reconnect-answer']);

function compactSdp(sdp) {
  return sdp.split(/\r?\n/u).filter((line) => !line.startsWith('a=candidate:') || / typ (host|srflx)(?: |$)/u.test(line)).join('\r\n');
}

async function compress(bytes) {
  if (typeof CompressionStream === 'undefined') return { mode: 0, bytes };
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return { mode: 1, bytes: new Uint8Array(await new Response(stream).arrayBuffer()) };
}

async function decompress(bytes) {
  if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot decompress handshake codes.');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function encodeHandshake({ kind, sdp, publicKey, senderName = '' }) {
  if (!KINDS.has(kind)) throw new Error('Unknown handshake type.');
  if (typeof sdp !== 'string' || !sdp.includes('v=0')) throw new Error('Invalid SDP in handshake.');
  const payload = {
    v: VERSION,
    k: kind,
    s: compactSdp(sdp),
    p: toBase64(publicKey),
    n: String(senderName).trim().slice(0, 60),
  };
  const compressed = await compress(utf8(JSON.stringify(payload)));
  return packPayload(concatBytes(Uint8Array.of(VERSION, compressed.mode), compressed.bytes));
}

export async function decodeHandshake(value, expectedKind = null) {
  let payload;
  try {
    const packed = unpackPayload(value);
    if (packed[0] !== VERSION) throw new Error('Unsupported handshake version.');
    const raw = packed[1] === 1 ? await decompress(packed.slice(2)) : packed.slice(2);
    payload = JSON.parse(fromUtf8(raw));
  } catch (error) {
    throw new Error('Handshake code is invalid or truncated.', { cause: error });
  }
  if (payload?.v !== VERSION || !KINDS.has(payload?.k) || typeof payload?.s !== 'string' || typeof payload?.p !== 'string') {
    throw new Error('Handshake code has an unsupported format.');
  }
  if (expectedKind && payload.k !== expectedKind) throw new Error(`Expected a ${expectedKind} handshake code.`);
  const publicKey = fromBase64(payload.p);
  if (publicKey.length !== 65) throw new Error('Handshake contains an invalid P-256 public key.');
  return { kind: payload.k, sdp: payload.s, publicKey, senderName: typeof payload.n === 'string' ? payload.n : '' };
}
