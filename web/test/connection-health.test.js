import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isStale,
  reconnectDelay,
  STALE_AFTER_MS,
  STALE_AFTER_WAKE_MS,
} from '../src/utils/connectionHealth.js';

test('isStale is false while messages keep arriving', () => {
  assert.equal(isStale(10_000, 9_800), false);
  assert.equal(isStale(10_000, 10_000 - STALE_AFTER_MS), false); // exactly at the limit is still fine
});

test('isStale is true once the silence exceeds the threshold', () => {
  assert.equal(isStale(20_000, 20_000 - STALE_AFTER_MS - 1), true);
  assert.equal(isStale(20_000, 1_000), true);
});

test('isStale ignores a socket that has not received anything yet', () => {
  assert.equal(isStale(50_000, 0), false);
});

test('isStale accepts a shorter threshold for wake-up checks', () => {
  assert.ok(STALE_AFTER_WAKE_MS < STALE_AFTER_MS);
  assert.equal(isStale(10_000, 10_000 - STALE_AFTER_WAKE_MS - 1, STALE_AFTER_WAKE_MS), true);
  assert.equal(isStale(10_000, 10_000 - STALE_AFTER_WAKE_MS - 1), false);
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
