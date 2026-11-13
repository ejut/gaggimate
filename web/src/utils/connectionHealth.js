// Pure helpers for the WebSocket health checks in ApiService (no browser APIs, so they can be unit tested).

// The firmware publishes evt:status about every 500 ms while a client is connected. This long without any
// message means the connection is dead, even if the browser still reports the socket as open
// (WiFi dropped without a TCP reset, the machine rebooted, the phone changed network).
export const STALE_AFTER_MS = 8000;

// Right after the tab wakes up or the network returns, judge sooner: timers were throttled while hidden.
export const STALE_AFTER_WAKE_MS = 3000;

// lastMessageAt === 0 means nothing has been received yet on this socket; that is not stale.
export function isStale(now, lastMessageAt, thresholdMs = STALE_AFTER_MS) {
  return lastMessageAt > 0 && now - lastMessageAt > thresholdMs;
}

// Exponential backoff. The first retry is quick, since most drops are brief; then 1 s, 2 s, 4 s ... up to max.
export function reconnectDelay(attempt, { first = 250, base = 1000, max = 30000 } = {}) {
  if (attempt <= 0) return first;
  return Math.min(base * 2 ** (attempt - 1), max);
}
