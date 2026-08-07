import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, equalBytes, utf8 } from '../crypto/bytes.js';
import { encryptPassphraseMessage, decryptPassphraseMessage, encryptRatchetMessage, decryptRatchetMessage } from '../crypto/message.js';
import { encryptAesGcm } from '../crypto/aes.js';
import { createRatchetState, RATCHET_DIRECTIONS, deriveRatchetStep } from '../crypto/ratchet.js';
import { generateEcdhKeyPair, exportPublicKey, deriveRootKey, safetyNumber } from '../crypto/ecdh.js';
import { estimatePassphraseStrength } from '../crypto/kdf.js';

test('1: passphrase AES-GCM round trip', async () => {
  const envelope = await encryptPassphraseMessage('amber violin cactus orbit maple', 'nội dung kín');
  assert.equal(await decryptPassphraseMessage('amber violin cactus orbit maple', envelope), 'nội dung kín');
});

test('2: ECDH ratchet round trips use different message keys', async () => {
  const root = randomBytes(32);
  const sender = await createRatchetState(root, RATCHET_DIRECTIONS.A_TO_B);
  const receiver = await createRatchetState(root, RATCHET_DIRECTIONS.A_TO_B);
  const observed = [];
  let chain = new Uint8Array(root);
  for (let n = 1; n <= 3; n += 1) {
    const step = await deriveRatchetStep(chain, n);
    observed.push(step.messageKey);
    chain = step.nextChainKey;
    const envelope = await encryptRatchetMessage(sender, `message ${n}`);
    assert.equal(await decryptRatchetMessage(receiver, envelope), `message ${n}`);
  }
  assert.equal(equalBytes(observed[0], observed[1]), false);
  assert.equal(equalBytes(observed[1], observed[2]), false);
});

test('3: wrong passphrase and wrong chain key fail loudly', async () => {
  const envelope = await encryptPassphraseMessage('harbor tulip winter compass ivory', 'secret');
  await assert.rejects(() => decryptPassphraseMessage('wrong passphrase entirely here', envelope), /Decryption failed/);
  const wrongSender = await createRatchetState(randomBytes(32), RATCHET_DIRECTIONS.A_TO_B);
  const wrongReceiver = await createRatchetState(randomBytes(32), RATCHET_DIRECTIONS.A_TO_B);
  const encrypted = await encryptRatchetMessage(wrongSender, 'secret');
  await assert.rejects(() => decryptRatchetMessage(wrongReceiver, encrypted), /Decryption failed/);
});

test('4: ciphertext bit modification is authenticated', async () => {
  const root = randomBytes(32);
  const sender = await createRatchetState(root, RATCHET_DIRECTIONS.A_TO_B);
  const encrypted = await encryptRatchetMessage(sender, 'authenticated');
  encrypted[encrypted.length - 3] ^= 1;
  const receiver = await createRatchetState(root, RATCHET_DIRECTIONS.A_TO_B);
  await assert.rejects(() => decryptRatchetMessage(receiver, encrypted), /modified data/);
  assert.equal(receiver.position, 0, 'unauthenticated input must not advance the receiver ratchet');
});

test('5: a past sequence reports that its key was destroyed', async () => {
  const root = randomBytes(32);
  const receiver = await createRatchetState(root, RATCHET_DIRECTIONS.A_TO_B);
  await receiver.advanceTo(3);
  await assert.rejects(() => receiver.advanceTo(2), /destroyed/);
});

test('6: receiver fast-forwards over missing messages', async () => {
  const root = randomBytes(32);
  const sender = await createRatchetState(root, RATCHET_DIRECTIONS.A_TO_B);
  const receiver = await createRatchetState(root, RATCHET_DIRECTIONS.A_TO_B);
  await encryptRatchetMessage(sender, 'lost one');
  await encryptRatchetMessage(sender, 'lost two');
  const target = await encryptRatchetMessage(sender, 'target');
  assert.equal(await decryptRatchetMessage(receiver, target), 'target');
  assert.equal(receiver.position, 3);
});

test('7: plaintexts in one padding bucket produce equal ciphertext lengths', async () => {
  const key = randomBytes(32);
  const short = await encryptAesGcm(key, 'a');
  const longer = await encryptAesGcm(key, 'a'.repeat(90));
  assert.equal(short.ciphertext.length, longer.ciphertext.length);
});

test('10: mixed UTF-8 content survives encryption', async () => {
  const text = 'Việt العربية 中文 Русский 😀';
  const root = randomBytes(32);
  const sender = await createRatchetState(root, RATCHET_DIRECTIONS.A_TO_B);
  const receiver = await createRatchetState(root, RATCHET_DIRECTIONS.A_TO_B);
  const envelope = await encryptRatchetMessage(sender, text);
  assert.equal(await decryptRatchetMessage(receiver, envelope), text);
});

test('14 and 18: ECDH root key and safety number agree from both directions', async () => {
  const a = await generateEcdhKeyPair();
  const b = await generateEcdhKeyPair();
  const pubA = await exportPublicKey(a.publicKey);
  const pubB = await exportPublicKey(b.publicKey);
  const [rootA, rootB] = await Promise.all([
    deriveRootKey(a.privateKey, pubB),
    deriveRootKey(b.privateKey, pubA),
  ]);
  assert.ok(equalBytes(rootA, rootB));
  assert.equal(await safetyNumber(pubA, pubB), await safetyNumber(pubB, pubA));
  assert.match(await safetyNumber(pubA, pubB), /^[0-9A-F]{8}$/);
});

test('16: obvious weak passphrases are blocked and five diceware words pass', () => {
  assert.equal(estimatePassphraseStrength('123456').accepted, false);
  assert.equal(estimatePassphraseStrength('harbor tulip winter compass ivory').accepted, true);
});
