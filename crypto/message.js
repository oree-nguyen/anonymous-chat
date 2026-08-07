import { asBytes, concatBytes, randomBytes, zeroize } from './bytes.js';
import { encryptAesGcm, decryptAesGcm, messageAad } from './aes.js';
import { passphraseRootKey } from './kdf.js';
import { RatchetState, RATCHET_DIRECTIONS, createRatchetState } from './ratchet.js';

const RATCHET_VERSION = 2;
const PASSPHRASE_VERSION = 2;
const DIRECTION_CODES = new Map([
  [RATCHET_DIRECTIONS.A_TO_B, 1],
  [RATCHET_DIRECTIONS.B_TO_A, 2],
  [RATCHET_DIRECTIONS.PASSPHRASE, 3],
]);

function writeSequence(sequence) {
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 0xFFFFFFFF) throw new RangeError('Invalid message sequence.');
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, sequence, false);
  return bytes;
}

function directionCode(direction) {
  const code = DIRECTION_CODES.get(direction);
  if (!code) throw new Error('Unsupported ratchet direction.');
  return code;
}

export async function encryptRatchetMessage(state, plaintext) {
  if (!(state instanceof RatchetState)) throw new TypeError('A RatchetState is required.');
  return state.withLock(async (lockedState) => {
    const { sequence, messageKey } = await lockedState.advanceUnlocked(lockedState.position + 1);
    try {
      const code = directionCode(lockedState.direction);
      const aad = concatBytes(messageAad(sequence), Uint8Array.of(code));
      const encrypted = await encryptAesGcm(messageKey, plaintext, { additionalData: aad });
      return concatBytes(Uint8Array.of(RATCHET_VERSION, code), writeSequence(sequence), encrypted.iv, encrypted.ciphertext);
    } finally {
      zeroize(messageKey);
    }
  });
}

export async function decryptRatchetMessage(state, envelope) {
  if (!(state instanceof RatchetState)) throw new TypeError('A RatchetState is required.');
  const bytes = asBytes(envelope);
  if (bytes.length < 35 || bytes[0] !== RATCHET_VERSION) throw new Error('Invalid ratchet message envelope.');
  const code = bytes[1];
  if (code !== directionCode(state.direction)) throw new Error('Ratchet message direction does not match the receive chain.');
  const sequence = new DataView(bytes.buffer, bytes.byteOffset + 2, 4).getUint32(0, false);
  return state.withLock(async (lockedState) => {
    const candidate = lockedState.clone();
    let committed = false;
    let messageKey;
    try {
      ({ messageKey } = await candidate.advanceUnlocked(sequence));
      const aad = concatBytes(messageAad(sequence), Uint8Array.of(code));
      const plaintext = await decryptAesGcm(messageKey, { iv: bytes.slice(6, 18), ciphertext: bytes.slice(18) }, { additionalData: aad });
      lockedState.replaceWith(candidate);
      committed = true;
      return plaintext;
    } finally {
      zeroize(messageKey);
      if (!committed) candidate.dispose();
    }
  });
}

export async function encryptPassphraseMessage(passphrase, plaintext) {
  const salt = randomBytes(16);
  const rootKey = await passphraseRootKey(passphrase, salt);
  let state;
  try {
    state = await createRatchetState(rootKey, RATCHET_DIRECTIONS.PASSPHRASE);
    const ratchetEnvelope = await encryptRatchetMessage(state, plaintext);
    return concatBytes(Uint8Array.of(PASSPHRASE_VERSION), salt, ratchetEnvelope);
  } finally {
    zeroize(rootKey);
    state?.dispose();
  }
}

export async function decryptPassphraseMessage(passphrase, envelope) {
  const bytes = asBytes(envelope);
  if (bytes.length < 52 || bytes[0] !== PASSPHRASE_VERSION) throw new Error('Invalid passphrase message envelope.');
  const rootKey = await passphraseRootKey(passphrase, bytes.slice(1, 17));
  let state;
  try {
    state = await createRatchetState(rootKey, RATCHET_DIRECTIONS.PASSPHRASE);
    return await decryptRatchetMessage(state, bytes.slice(17));
  } finally {
    zeroize(rootKey);
    state?.dispose();
  }
}
