import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeHandshake, decodeHandshake } from '../webrtc/handshake.js';
import { randomBytes } from '../crypto/bytes.js';
import { createRatchetState, RATCHET_DIRECTIONS } from '../crypto/ratchet.js';
import { encryptRatchetMessage, decryptRatchetMessage } from '../crypto/message.js';
import { FallbackController } from '../webrtc/fallback.js';

test('17: a long SDP handshake round-trips exactly', () => {
  const sdp = `v=0\r\n${Array.from({ length: 120 }, (_, index) => `a=candidate:${index} 1 udp 1 192.0.2.${index % 250} ${5000 + index} typ host\r\n`).join('')}`;
  const publicKey = Uint8Array.from({ length: 65 }, (_, index) => index);
  const code = encodeHandshake({ kind: 'offer', sdp, publicKey });
  const decoded = decodeHandshake(code, 'offer');
  assert.equal(decoded.sdp, sdp);
  assert.deepEqual(decoded.publicKey, publicKey);
});

class FakeTransport extends EventTarget {
  closeUnexpectedly() {
    this.dispatchEvent(new CustomEvent('close', { detail: { intentional: false } }));
  }
  open() { this.dispatchEvent(new Event('open')); }
}

test('19: unexpected channel loss preserves ratchets for manual fallback', async () => {
  const root = randomBytes(32);
  const sender = await createRatchetState(root, RATCHET_DIRECTIONS.A_TO_B);
  const receiver = await createRatchetState(root, RATCHET_DIRECTIONS.A_TO_B);
  const controller = new FallbackController({ sendRatchet: sender, receiveRatchet: receiver });
  const transport = new FakeTransport();
  controller.attach(transport);
  transport.open();
  const first = await encryptRatchetMessage(sender, 'online');
  assert.equal(await decryptRatchetMessage(receiver, first), 'online');
  transport.closeUnexpectedly();
  assert.equal(controller.mode, 'manual');
  assert.deepEqual(controller.snapshot(), { mode: 'manual', sendPosition: 1, receivePosition: 1 });
  const next = await encryptRatchetMessage(sender, 'fallback');
  assert.equal(await decryptRatchetMessage(receiver, next), 'fallback');
});

test('20: reopening transport continues from the saved ratchet position', async () => {
  const root = randomBytes(32);
  const sender = await createRatchetState(root, RATCHET_DIRECTIONS.A_TO_B);
  const receiver = await createRatchetState(root, RATCHET_DIRECTIONS.A_TO_B);
  const controller = new FallbackController({ sendRatchet: sender, receiveRatchet: receiver });
  const transport = new FakeTransport();
  controller.attach(transport);
  transport.open();
  const first = await encryptRatchetMessage(sender, 'one');
  await decryptRatchetMessage(receiver, first);
  transport.closeUnexpectedly();
  const second = await encryptRatchetMessage(sender, 'two');
  await decryptRatchetMessage(receiver, second);
  transport.open();
  const third = await encryptRatchetMessage(sender, 'three');
  assert.equal(await decryptRatchetMessage(receiver, third), 'three');
  assert.equal(sender.position, 3);
  assert.equal(receiver.position, 3);
});
