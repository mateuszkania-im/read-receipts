import { describe, expect, it } from 'vitest';
import { bestOf, perfFloorMBps } from './floor.js';

describe('perf floor (CI throughput check)', () => {
  it('is 10 MB/s on Node below 22 and 17 MB/s from Node 22 on', () => {
    expect(perfFloorMBps('v20.19.0')).toBe(10);
    expect(perfFloorMBps('v20.20.1')).toBe(10);
    expect(perfFloorMBps('v21.7.3')).toBe(10);
    expect(perfFloorMBps('v22.0.0')).toBe(17);
    expect(perfFloorMBps('v24.1.0')).toBe(17);
  });
  it('runs the measurement the given number of times and keeps the best', async () => {
    const seen = [5, 12, 9];
    let i = 0;
    const r = await bestOf(3, async () => ({ mbps: seen[i++]!, run: i }));
    expect(i).toBe(3);
    expect(r).toEqual({ mbps: 12, run: 2 });
  });
});
