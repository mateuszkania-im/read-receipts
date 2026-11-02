// `--json`: the report object as is (spec section 8), Maps already flattened by the pipeline.

import type { Report } from './types.js';

export function renderJson(r: Report): string {
  return `${JSON.stringify(r, null, 2)}\n`;
}
