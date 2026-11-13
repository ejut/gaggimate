import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extendGrace,
  graceAfterOtaProgress,
  inGrace,
  isStale,
  OTA_CHECK_GRACE_MS,
  OTA_GRACE_MS,
  OTA_PHASE_FAILED,
  OTA_PHASE_FINISHED,
  reconnectDelay,
  STALE_AFTER_MS,
  STALE_AFTER_WAKE_MS,
} from '../src/utils/connectionHealth.js';

const NOW = 1_000_000; // far from 0, so "NOW - threshold" is a real timestamp

test('isStale is false while messages keep arriving', () => {
  assert.equal(isStale(NOW, NOW - 300), false);
  assert.equal(isStale(NOW, NOW - STALE_AFTER_MS), false); // exactly at the limit is still fine
});

test('isStale is true once the silence exceeds the threshold', () => {
  assert.equal(isStale(NOW, NOW - STALE_AFTER_MS - 1), true);
  assert.equal(isStale(NOW, 1_000), true);
});

test('isStale ignores a socket that has not received anything yet', () => {
  assert.equal(isStale(NOW, 0), false);
});

test('isStale accepts a shorter threshold for wake-up checks', () => {
  assert.ok(STALE_AFTER_WAKE_MS < STALE_AFTER_MS);
  const lastMessageAt = NOW - STALE_AFTER_WAKE_MS - 1;
  assert.equal(isStale(NOW, lastMessageAt, STALE_AFTER_WAKE_MS), true);
  assert.equal(isStale(NOW, lastMessageAt), false);
});

test('the silence limit outlasts a blocking update check (two 5 s HTTP timeouts plus TLS)', () => {
  assert.ok(STALE_AFTER_MS >= 20_000);
  assert.ok(STALE_AFTER_WAKE_MS > 500 * 4); // and is well above the 500 ms status period
});

test('reconnectDelay retries quickly first, then backs off exponentially up to the cap', () => {
  assert.equal(reconnectDelay(0), 250);
  assert.deepEqual(
    [1, 2, 3, 4].map(n => reconnectDelay(n)),
    [1000, 2000, 4000, 8000],
  );
  assert.equal(reconnectDelay(5), 16000);
  assert.equal(reconnectDelay(6), 30000);
  assert.equal(reconnectDelay(50), 30000);
});

test('reconnectDelay treats a negative attempt like the first one', () => {
  assert.equal(reconnectDelay(-3), 250);
});

test('extendGrace sets a deadline and never moves an existing, later one earlier', () => {
  assert.equal(extendGrace(NOW, 0, OTA_CHECK_GRACE_MS), NOW + OTA_CHECK_GRACE_MS);
  const longer = NOW + OTA_GRACE_MS;
  assert.equal(extendGrace(NOW, longer, OTA_CHECK_GRACE_MS), longer);
});

test('inGrace is true only before the deadline', () => {
  assert.equal(inGrace(NOW, 0), false);
  assert.equal(inGrace(NOW, NOW - 1), false);
  assert.equal(inGrace(NOW, NOW), false);
  assert.equal(inGrace(NOW, NOW + 1), true);
});

test('running OTA phases keep extending the grace period', () => {
  for (const phase of [1, 2, 3]) {
    assert.equal(graceAfterOtaProgress(NOW, 0, phase), NOW + OTA_GRACE_MS);
  }
  const later = NOW + 50_000;
  assert.equal(graceAfterOtaProgress(later, NOW + OTA_GRACE_MS, 1), later + OTA_GRACE_MS);
});

test('a finished or failed update ends the grace period', () => {
  assert.equal(graceAfterOtaProgress(NOW, NOW + OTA_GRACE_MS, OTA_PHASE_FINISHED), 0);
  assert.equal(graceAfterOtaProgress(NOW, NOW + OTA_GRACE_MS, OTA_PHASE_FAILED), 0);
});

test('the OTA grace covers a long erase, and stays bounded if the update dies silently', () => {
  assert.ok(OTA_GRACE_MS >= 60_000); // well above the ~10 s flash erase plus TLS before the first progress frame
  assert.ok(OTA_GRACE_MS <= 300_000); // but a dead device is still noticed within minutes
});
