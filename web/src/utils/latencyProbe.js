import { signal } from '@preact/signals';

// Dev aid for measuring WebUI <-> firmware latency. Off unless the page is opened with ?latency
// or localStorage `gaggimate.latencyProbe` is "1"; when off, none of the probe code runs.
function readEnabled() {
  try {
    return (
      new URLSearchParams(window.location.search).has('latency') ||
      window.localStorage.getItem('gaggimate.latencyProbe') === '1'
    );
  } catch {
    return false;
  }
}

export const latencyProbeEnabled = readEnabled();

// rtt: ping round trip (ms). command: time from sending a command until the status frame showing its result.
export const latencyStats = signal({ rtt: null, command: null, commandType: '' });

// Requests whose result shows up in the next slow-state frame of evt:status.
export const STATUS_COMMANDS = new Set([
  'req:process:activate',
  'req:process:deactivate',
  'req:process:clear',
  'req:grind:activate',
  'req:grind:deactivate',
  'req:change-mode',
  'req:steam:toggle',
  'req:scale:tare',
  'req:flush:start',
  'req:flush:stop',
  'req:profiles:select',
]);
