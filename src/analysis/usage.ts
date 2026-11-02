// Token usage arithmetic shared by the cost pass, the parsers and the report totals.

import type { Usage } from '../model.js';

export function zeroUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
}

export function addUsage(into: Usage, u: Usage): void {
  into.input += u.input;
  into.output += u.output;
  into.cacheRead += u.cacheRead;
  into.cacheWrite5m += u.cacheWrite5m;
  into.cacheWrite1h += u.cacheWrite1h;
}

/** A cost is a lower bound when some requests had no usage, an unpriced model or an unpriced modifier. */
export function isLowerBound(c: { requestsMissingUsage: number; requestsUnpriced: number; requestsUnpricedModifier: number }): boolean {
  return c.requestsMissingUsage > 0 || c.requestsUnpriced > 0 || c.requestsUnpricedModifier > 0;
}
