import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeQr } from '../qr/qr-encode.js';
import { decodeQr } from '../qr/qr-decode.js';
import { generateOtpKey, otpEncrypt, OtpUsageTracker, OTP_DIRECTIONS } from '../crypto/otp.js';
import { applyDirection } from '../i18n.js';

test('11: visual code matrix round-trips multiple payload sizes', () => {
  for (const length of [0, 1, 32, 65, 128]) {
    const bytes = Uint8Array.from({ length }, (_, index) => (index * 37) % 256);
    assert.deepEqual(decodeQr(encodeQr(bytes)), bytes);
  }
});

test('12: OTP refuses reuse of an already consumed region', async () => {
  const key = generateOtpKey(512);
  const tracker = new OtpUsageTracker();
  await otpEncrypt('first', key, tracker, OTP_DIRECTIONS.A_TO_B, 0);
  await assert.rejects(() => otpEncrypt('reuse', key, tracker, OTP_DIRECTIONS.A_TO_B, 0), /reuse|rollback/);
});

test('13: OTP rejects a key shorter than padded plaintext', async () => {
  const tracker = new OtpUsageTracker();
  await assert.rejects(() => otpEncrypt('x'.repeat(200), new Uint8Array(128), tracker, OTP_DIRECTIONS.A_TO_B), /at least|enough unused bytes/);
});

test('15: Arabic and Persian set right-to-left document direction', () => {
  const documentObject = { documentElement: {} };
  applyDirection(documentObject, 'ar');
  assert.equal(documentObject.documentElement.dir, 'rtl');
  applyDirection(documentObject, 'fa');
  assert.equal(documentObject.documentElement.dir, 'rtl');
  applyDirection(documentObject, 'en');
  assert.equal(documentObject.documentElement.dir, 'ltr');
});
