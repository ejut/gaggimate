// Pure helpers for the WebSocket health checks in ApiService (no browser APIs, so they can be unit tested).

// The firmware publishes evt:status about every 500 ms while a client is connected, but only while its main
// loop runs. That loop also runs the update check (HTTPS to GitHub, 5 s timeouts, so up to ~20 s on a bad
// network), so a long silence does not always mean the connection is dead. This is generous on purpose: it
// still replaces a half-open socket long before the browser's own TCP timeout would.
export const STALE_AFTER_MS = 30000;

// Right after the tab wakes up or the network returns, judge sooner: timers were throttled while hidden.
export const STALE_AFTER_WAKE_MS = 5000;

// A firmware update blocks the firmware's main loop (and so the status frames) for long stretches: TLS and
// redirects, then erasing the whole image area in flash (~10 s) before the first progress frame, and the
// controller transfer. While an update runs, silence is expected.
export const OTA_GRACE_MS = 120000;
// Changing the release channel triggers an immediate, blocking update check.
export const OTA_CHECK_GRACE_MS = 30000;
// Phases of evt:ota-progress, see PHASE_* in lib/OTA/src/GitHubOTA.h.
export const OTA_PHASE_FINISHED = 4;
export const OTA_PHASE_FAILED = 5;

// lastMessageAt === 0 means nothing has been received yet on this socket; that is not stale.
export function isStale(now, lastMessageAt, thresholdMs = STALE_AFTER_MS) {
  return lastMessageAt > 0 && now - lastMessageAt > thresholdMs;
}

// Exponential backoff. The first retry is quick, since most drops are brief; then 1 s, 2 s, 4 s ... up to max.
export function reconnectDelay(attempt, { first = 250, base = 1000, max = 30000 } = {}) {
  if (attempt <= 0) return first;
  return Math.min(base * 2 ** (attempt - 1), max);
}

// Deadline (performance.now() time) until which silence is expected, never earlier than the current one.
export function extendGrace(now, currentUntil, graceMs) {
  return Math.max(currentUntil, now + graceMs);
}

// Grace deadline after an evt:ota-progress frame: running phases keep extending it; finished or failed ends it,
// because the firmware is serving status again (or has restarted).
export function graceAfterOtaProgress(now, currentUntil, phase) {
  if (phase === OTA_PHASE_FINISHED || phase === OTA_PHASE_FAILED) return 0;
  return extendGrace(now, currentUntil, OTA_GRACE_MS);
}

export function inGrace(now, graceUntil) {
  return graceUntil > now;
}
