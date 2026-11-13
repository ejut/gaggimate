import { latencyProbeEnabled, latencyStats } from '../utils/latencyProbe.js';

const fmt = value => (value === null ? '–' : `${Math.round(value)} ms`);

// Small readout in the corner, only rendered when the latency probe is enabled (see latencyProbe.js).
export function LatencyBadge() {
  if (!latencyProbeEnabled) return null;
  const { rtt, command, commandType } = latencyStats.value;
  return (
    <div
      className='bg-neutral text-neutral-content pointer-events-none fixed right-2 bottom-2 z-[10000] rounded px-2 py-1 font-mono text-xs opacity-80'
      title={commandType}
    >
      RTT {fmt(rtt)} · cmd {fmt(command)}
    </div>
  );
}
