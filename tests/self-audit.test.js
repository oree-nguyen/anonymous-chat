import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes, equalBytes } from '../crypto/bytes.js';
import { encryptAesGcm } from '../crypto/aes.js';
import { RatchetState, createRatchetState, RATCHET_DIRECTIONS } from '../crypto/ratchet.js';
import { encryptRatchetMessage, decryptRatchetMessage } from '../crypto/message.js';
import { generateEcdhKeyPair, exportPublicKey, deriveRootKey, safetyNumber, roleForPublicKeys } from '../crypto/ecdh.js';
import { bufToEmoji, emojiToBuf } from '../crypto/emoji-codec.js';
import { EMOJI_TABLE } from '../crypto/emoji-table.js';
import { generateOtpKey, otpEncrypt, otpDecrypt, OtpUsageTracker, OTP_DIRECTIONS } from '../crypto/otp.js';
import { encodeQr } from '../qr/qr-encode.js';
import { decodeQr } from '../qr/qr-decode.js';

test('self-audit: default AES-GCM encryption generates a fresh IV for every call', async () => {
  const key = randomBytes(32);
  const payloads = await Promise.all(Array.from({ length: 32 }, () => encryptAesGcm(key, 'same plaintext')));
  const ivs = new Set(payloads.map(({ iv }) => Buffer.from(iv).toString('hex')));
  assert.equal(ivs.size, payloads.length);
});

test('self-audit TODO: callers cannot override the AES-GCM IV', async () => {
  await assert.rejects(() => encryptAesGcm(randomBytes(32), 'message', { iv: new Uint8Array(12) }));
});

test('self-audit TODO: concurrent ratchet advances receive distinct sequences and keys', async () => {
  const state = new RatchetState(randomBytes(32), RATCHET_DIRECTIONS.A_TO_B);
  const [first, second] = await Promise.all([state.next(), state.next()]);
  assert.notEqual(first.sequence, second.sequence);
  assert.equal(equalBytes(first.messageKey, second.messageKey), false);
  assert.equal(state.position, 2);
});

test('self-audit TODO: opposite directions derive independent message keys', async () => {
  const root = randomBytes(32);
  const outboundA = await (await createRatchetState(root, RATCHET_DIRECTIONS.A_TO_B)).next();
  const outboundB = await (await createRatchetState(root, RATCHET_DIRECTIONS.B_TO_A)).next();
  assert.equal(equalBytes(outboundA.messageKey, outboundB.messageKey), false);
});

test('self-audit TODO: a reflected outbound envelope is rejected by the sender', async () => {
  const root = randomBytes(32);
  const sender = await createRatchetState(root, RATCHET_DIRECTIONS.A_TO_B);
  const reflectedReceiveChain = await createRatchetState(root, RATCHET_DIRECTIONS.B_TO_A);
  const envelope = await encryptRatchetMessage(sender, 'from A');
  await assert.rejects(() => decryptRatchetMessage(reflectedReceiveChain, envelope), /direction/);
});

test('self-audit TODO: serialized ratchet state contains no chain key', () => {
  const saved = new RatchetState(randomBytes(32), RATCHET_DIRECTIONS.A_TO_B, 7).serialize();
  assert.deepEqual(saved, { position: 7 });
});

test('self-audit TODO: restoring a stale snapshot cannot recreate a consumed message key', async () => {
  const state = new RatchetState(randomBytes(32), RATCHET_DIRECTIONS.A_TO_B);
  const staleSnapshot = state.serialize();
  await state.next();
  assert.throws(() => RatchetState.restore(staleSnapshot), /not persisted|fresh handshake/);
});

test('self-audit: encrypted session snapshots restore the current ratchet position', async () => {
  const state = new RatchetState(randomBytes(32), RATCHET_DIRECTIONS.A_TO_B);
  const first = await state.next();
  first.messageKey.fill(0);
  const snapshot = state.exportPersistenceState();
  const restored = RatchetState.restorePersistenceState(snapshot);
  assert.equal(restored.position, state.position);
  const [originalNext, restoredNext] = await Promise.all([state.next(), restored.next()]);
  assert.equal(equalBytes(originalNext.messageKey, restoredNext.messageKey), true);
  originalNext.messageKey.fill(0);
  restoredNext.messageKey.fill(0);
  snapshot.chainKey.fill(0);
  state.dispose();
  restored.dispose();
});

test('self-audit: session vault stores no transcript or message key fields', async () => {
  const source = await readFile(new URL('../session-vault.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /conversationMessages|messageKey/);
  assert.match(source, /const serializable = \{/);
  assert.doesNotMatch(source, /serializable\s*=\s*\{[\s\S]*messages/);
  assert.match(source, /PBKDF2/);
  assert.match(source, /iterations: PIN_ITERATIONS/);
  assert.match(source, /const extractable = false/);
  assert.match(source, /AES-GCM/);
});

test('self-audit TODO: persisted conversations contain no plaintext transcript', async () => {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /messages:\s*conversationMessages/);
  assert.doesNotMatch(source, /saved\.messages/);
  assert.match(source, /scrubLegacyConversationStorage\(\)/);
});

test('self-audit: ratchet role ordering supports authenticated traffic in both directions', async () => {
  const root = randomBytes(32);
  const aSend = await createRatchetState(root, RATCHET_DIRECTIONS.A_TO_B);
  const bReceive = await createRatchetState(root, RATCHET_DIRECTIONS.A_TO_B);
  const bSend = await createRatchetState(root, RATCHET_DIRECTIONS.B_TO_A);
  const aReceive = await createRatchetState(root, RATCHET_DIRECTIONS.B_TO_A);
  const [toB, toA] = await Promise.all([
    encryptRatchetMessage(aSend, 'A to B'),
    encryptRatchetMessage(bSend, 'B to A'),
  ]);
  assert.equal(await decryptRatchetMessage(bReceive, toB), 'A to B');
  assert.equal(await decryptRatchetMessage(aReceive, toA), 'B to A');
});

test('self-audit: public-key ordering assigns opposite stable A/B roles', async () => {
  const [a, b] = await Promise.all([generateEcdhKeyPair(), generateEcdhKeyPair()]);
  const [pubA, pubB] = await Promise.all([exportPublicKey(a.publicKey), exportPublicKey(b.publicKey)]);
  const localRole = roleForPublicKeys(pubA, pubB);
  const remoteRole = roleForPublicKeys(pubB, pubA);
  assert.notEqual(localRole, remoteRole);
  assert.deepEqual(new Set([localRole, remoteRole]), new Set(['A', 'B']));
});

test('self-audit: a failed ratchet queue job does not block later jobs', async () => {
  const state = new RatchetState(randomBytes(32), RATCHET_DIRECTIONS.A_TO_B);
  await assert.rejects(() => state.advanceTo(0));
  const next = await state.next();
  assert.equal(next.sequence, 1);
});

test('self-audit: OTP refuses explicit reuse of a consumed key region', async () => {
  const key = generateOtpKey(512);
  const tracker = new OtpUsageTracker();
  await otpEncrypt('first', key, tracker, OTP_DIRECTIONS.A_TO_B, 0);
  await assert.rejects(() => otpEncrypt('reuse', key, tracker, OTP_DIRECTIONS.A_TO_B, 0), /reuse|rollback/);
});

test('self-audit TODO: opposite OTP directions cannot allocate the same key bytes', async () => {
  const key = generateOtpKey(512);
  const [fromA, fromB] = await Promise.all([
    otpEncrypt('from A', key, new OtpUsageTracker(), OTP_DIRECTIONS.A_TO_B),
    otpEncrypt('from B', key, new OtpUsageTracker(), OTP_DIRECTIONS.B_TO_A),
  ]);
  const endA = fromA.offset + fromA.ciphertext.length;
  const endB = fromB.offset + fromB.ciphertext.length;
  assert.ok(endA <= fromB.offset || endB <= fromA.offset);
});

test('self-audit TODO: OTP ciphertext modification is rejected', async () => {
  const key = generateOtpKey(512);
  const encrypted = await otpEncrypt('Alpha', key, new OtpUsageTracker(), OTP_DIRECTIONS.A_TO_B);
  encrypted.ciphertext[2] ^= 1;
  await assert.rejects(() => otpDecrypt(encrypted, key), /authentication/);
});

test('self-audit: authenticated OTP round-trips independently in both directions', async () => {
  const key = generateOtpKey(1024);
  const aToB = await otpEncrypt('A to B', key, new OtpUsageTracker(), OTP_DIRECTIONS.A_TO_B);
  const bToA = await otpEncrypt('B to A', key, new OtpUsageTracker(), OTP_DIRECTIONS.B_TO_A);
  assert.equal(new TextDecoder().decode(await otpDecrypt(aToB, key, new OtpUsageTracker())), 'A to B');
  assert.equal(new TextDecoder().decode(await otpDecrypt(bToA, key, new OtpUsageTracker())), 'B to A');
});

test('self-audit TODO: failed OTP decryption does not consume key bytes', async () => {
  const key = generateOtpKey(512);
  const encrypted = await otpEncrypt('message', key, new OtpUsageTracker(), OTP_DIRECTIONS.A_TO_B);
  encrypted.ciphertext[encrypted.ciphertext.length - 1] ^= 1;
  const receiver = new OtpUsageTracker();
  await assert.rejects(() => otpDecrypt(encrypted, key, receiver), /authentication/);
  assert.equal(receiver.getOffset(encrypted.fileId, OTP_DIRECTIONS.A_TO_B), 0);
});

test('self-audit TODO: malformed persisted OTP offsets are rejected explicitly', () => {
  const storage = { getItem: () => 'not-a-number', setItem: () => {} };
  const tracker = new OtpUsageTracker(storage);
  assert.throws(() => tracker.getOffset('file', OTP_DIRECTIONS.A_TO_B), /corrupted/);
});

test('self-audit TODO: malformed emoji and cryptographic failure expose one generic message', async () => {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8');
  assert.match(source, /reportError\(error, t\('openFailed'\)\)/);
  assert.match(source, /manual-decrypt'[\s\S]*runDecryption/);
  assert.match(source, /otp-decrypt'[\s\S]*runDecryption/);
});

test('self-audit TODO: direct emoji decoding rejects non-canonical extra zero symbols', () => {
  const bytes = Uint8Array.of(0x42);
  const encoded = bufToEmoji(bytes);
  assert.throws(() => emojiToBuf(`${encoded}${EMOJI_TABLE[0]}`, bytes.length));
});

test('self-audit: visual matrix corruption is rejected by checksum validation', () => {
  const code = encodeQr(Uint8Array.from({ length: 48 }, (_, index) => index));
  let rejected = false;
  for (let index = 0; index < code.modules.length; index += 1) {
    const changed = { ...code, modules: new Uint8Array(code.modules) };
    changed.modules[index] ^= 1;
    try {
      decodeQr(changed);
    } catch {
      rejected = true;
      break;
    }
  }
  assert.equal(rejected, true);
});

test('self-audit: ECDH roots and sorted safety numbers agree across random identities', async () => {
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const [a, b] = await Promise.all([generateEcdhKeyPair(), generateEcdhKeyPair()]);
    const [pubA, pubB] = await Promise.all([exportPublicKey(a.publicKey), exportPublicKey(b.publicKey)]);
    const [rootA, rootB, numberAB, numberBA] = await Promise.all([
      deriveRootKey(a.privateKey, pubB),
      deriveRootKey(b.privateKey, pubA),
      safetyNumber(pubA, pubB),
      safetyNumber(pubB, pubA),
    ]);
    assert.equal(equalBytes(rootA, rootB), true);
    assert.equal(numberAB, numberBA);
  }
});
