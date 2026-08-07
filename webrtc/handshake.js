import { utf8, fromUtf8, toBase64, fromBase64 } from '../crypto/bytes.js';
import { packPayload, unpackPayload } from '../crypto/emoji-codec.js';

const VERSION = 1;
const KINDS = new Set(['offer', 'answer', 'reconnect-offer', 'reconnect-answer']);

export function encodeHandshake({ kind, sdp, publicKey }) {
  if (!KINDS.has(kind)) throw new Error('Unknown handshake type.');
  if (typeof sdp !== 'string' || !sdp.includes('v=0')) throw new Error('Invalid SDP in handshake.');
  const payload = {
    v: VERSION,
    k: kind,
    s: sdp,
    p: toBase64(publicKey),
  };
  return packPayload(utf8(JSON.stringify(payload)));
}

export function decodeHandshake(value, expectedKind = null) {
  let payload;
  try {
    payload = JSON.parse(fromUtf8(unpackPayload(value)));
  } catch (error) {
    throw new Error('Handshake code is invalid or truncated.', { cause: error });
  }
  if (payload?.v !== VERSION || !KINDS.has(payload?.k) || typeof payload?.s !== 'string' || typeof payload?.p !== 'string') {
    throw new Error('Handshake code has an unsupported format.');
  }
  if (expectedKind && payload.k !== expectedKind) throw new Error(`Expected a ${expectedKind} handshake code.`);
  const publicKey = fromBase64(payload.p);
  if (publicKey.length !== 65) throw new Error('Handshake contains an invalid P-256 public key.');
  return { kind: payload.k, sdp: payload.s, publicKey };
}
