// The CI throughput floor. Shared runners are noisy, so the perf test measures several times and keeps
// the best run; Node 20 parses measurably slower than Node 22, so it gets a lower floor.

/** The minimum MB/s for a Node version string such as `v20.19.0`. */
export function perfFloorMBps(version: string = process.version): number {
  const major = Number(/^v?(\d+)/.exec(version)?.[1] ?? '0');
  return major < 22 ? 10 : 17;
}

/** Runs `measure` `n` times in a row and returns the run with the highest `mbps`. */
export async function bestOf<T extends { mbps: number }>(n: number, measure: () => Promise<T>): Promise<T> {
  let best: T | null = null;
  for (let i = 0; i < n; i++) {
    const r = await measure();
    if (best === null || r.mbps > best.mbps) best = r;
  }
  return best!;
}
