import { asBytes, concatBytes, utf8, zeroize } from './bytes.js';
import { hkdf } from './kdf.js';

export const MAX_SKIP = 1000;
export const RATCHET_DIRECTIONS = Object.freeze({
  A_TO_B: 'A-to-B',
  B_TO_A: 'B-to-A',
  PASSPHRASE: 'passphrase',
});

const VALID_DIRECTIONS = new Set(Object.values(RATCHET_DIRECTIONS));

function validateDirection(direction) {
  if (!VALID_DIRECTIONS.has(direction)) throw new Error('A valid ratchet direction is required.');
  return direction;
}

function sequenceBytes(sequence) {
  const output = new Uint8Array(8);
  new DataView(output.buffer).setBigUint64(0, BigInt(sequence), false);
  return output;
}

export async function deriveRatchetStep(chainKey, sequence) {
  const current = asBytes(chainKey);
  const messageKey = await hkdf(current, concatBytes(utf8('msg-key'), sequenceBytes(sequence)));
  try {
    const nextChainKey = await hkdf(current, 'chain-advance');
    return { messageKey, nextChainKey };
  } catch (error) {
    zeroize(messageKey);
    throw error;
  }
}

export async function createRatchetState(rootKey, direction) {
  validateDirection(direction);
  const initialChainKey = await hkdf(asBytes(rootKey), `ratchet-${direction}`);
  try {
    return new RatchetState(initialChainKey, direction);
  } finally {
    zeroize(initialChainKey);
  }
}

export class RatchetState {
  #queue = Promise.resolve();

  constructor(chainKey, direction, position = 0) {
    this.direction = validateDirection(direction);
    this.chainKey = new Uint8Array(asBytes(chainKey));
    if (this.chainKey.length !== 32) throw new Error('Ratchet chain key must be 32 bytes.');
    if (!Number.isSafeInteger(position) || position < 0) throw new RangeError('Invalid ratchet position.');
    this.position = position;
  }

  #enqueue(operation) {
    const job = this.#queue.then(operation);
    this.#queue = job.catch(() => {});
    return job;
  }

  async next() {
    return this.#enqueue(() => this.advanceUnlocked(this.position + 1));
  }

  async advanceTo(target) {
    return this.#enqueue(() => this.advanceUnlocked(target));
  }

  async withLock(operation) {
    if (typeof operation !== 'function') throw new TypeError('Ratchet operation must be a function.');
    return this.#enqueue(() => operation(this));
  }

  async advanceUnlocked(target) {
    if (!Number.isSafeInteger(target) || target < 1) throw new RangeError('Invalid target sequence.');
    if (target <= this.position) throw new Error('Message key has already been destroyed.');
    if (target - this.position > MAX_SKIP) throw new Error(`Refusing to skip more than ${MAX_SKIP} ratchet steps.`);
    let messageKey;
    while (this.position < target) {
      const nextSequence = this.position + 1;
      const previous = this.chainKey;
      const step = await deriveRatchetStep(previous, nextSequence);
      zeroize(previous);
      if (messageKey) zeroize(messageKey);
      messageKey = step.messageKey;
      this.chainKey = step.nextChainKey;
      this.position = nextSequence;
    }
    return { sequence: target, messageKey };
  }

  clone() {
    return new RatchetState(this.chainKey, this.direction, this.position);
  }

  replaceWith(candidate) {
    if (!(candidate instanceof RatchetState) || candidate.direction !== this.direction) {
      throw new Error('Cannot commit an incompatible ratchet state.');
    }
    zeroize(this.chainKey);
    this.chainKey = candidate.chainKey;
    this.position = candidate.position;
    candidate.chainKey = new Uint8Array(0);
  }

  serialize() {
    return { position: this.position };
  }

  dispose() {
    zeroize(this.chainKey);
    this.chainKey = new Uint8Array(0);
    this.position = 0;
  }

  static restore() {
    throw new Error('Ratchet keys are not persisted. Start a fresh handshake after reloading.');
  }
}
