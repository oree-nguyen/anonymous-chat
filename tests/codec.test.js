import test from 'node:test';
import assert from 'node:assert/strict';
import { EMOJI_TABLE } from '../crypto/emoji-table.js';
import { bufToEmoji, emojiToBuf, packPayload, unpackPayload } from '../crypto/emoji-codec.js';

test('8: emoji table contains unique, single-code-point symbols', () => {
  assert.equal(new Set(EMOJI_TABLE).size, EMOJI_TABLE.length);
  assert.ok(EMOJI_TABLE.length >= 256);
  assert.ok(EMOJI_TABLE.every((character) => [...character].length === 1));
});

test('9: emoji codec round-trips every byte length from 0 through 256', () => {
  for (let length = 0; length <= 256; length += 1) {
    const bytes = Uint8Array.from({ length }, (_, index) => (index * 71 + length) % 256);
    assert.deepEqual(emojiToBuf(bufToEmoji(bytes), length), bytes);
    assert.deepEqual(unpackPayload(packPayload(bytes)), bytes);
  }
});

test('emoji codec refuses changed, invalid, and truncated input', () => {
  const packed = packPayload(Uint8Array.of(1, 2, 3, 4));
  assert.throws(() => unpackPayload(packed.slice(0, -2)), /length|truncated/);
  assert.throws(() => unpackPayload(`${packed.slice(0, 1)}A${packed.slice(2)}`), /invalid/i);
});
