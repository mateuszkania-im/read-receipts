// Cache-adjusted cost per session (spec section 6.1).

import type { RequestEvent, Usage } from '../model.js';
import { lookupPrice, modifierIssue, requestCost, type PriceTable } from '../prices/table.js';
import { addUsage, zeroUsage } from './usage.js';

export interface CostSummary {
  /** Sum of the priced requests only; a lower bound when requestsMissingUsage or requestsUnpriced is non-zero. */
  usd: number;
  requests: number;
  requestsMissingUsage: number;
  requestsUnpriced: number;
  unpricedModels: string[];
  /** Requests whose model is priced but whose fast mode or inference_geo value is not: left out of usd. */
  requestsUnpricedModifier: number;
  /** `<model> <modifier>=<value>` for each such combination. */
  unpricedModifiers: string[];
  /** Requests with cache writes priced at the input price because the vendor page gives no write price. */
  requestsApproxWritePrice: number;
  byModel: Map<string, { usd: number; usage: Usage }>;
  usage: Usage;
  cacheHitShare: number | null;
  /** Claude Code's own total (cost-state): the last value of each process, summed. */
  harnessUSD: number | null;
  /** harnessUSD minus usd: calls without a transcript record (compaction and similar). */
  unloggedUSD: number | null;
  /** The computed cost exceeds Claude Code's own total by more than 1%: the price table is likely off. */
  priceMismatch: boolean;
}

/** A computed cost above the harness total by up to this share is rounding, shown as 0. */
const MISMATCH_TOLERANCE = 0.01;

export class CostAccumulator {
  private usd = 0;
  private requests = 0;
  private missingUsage = 0;
  private unpriced = 0;
  private readonly unpricedModels = new Set<string>();
  private unpricedModifier = 0;
  private readonly unpricedModifiers = new Set<string>();
  private approxWrites = 0;
  private readonly byModel = new Map<string, { usd: number; usage: Usage }>();
  private readonly usage = zeroUsage();
  /** Last cost-state value of each finished process, and of the current one. */
  private harnessDone = 0;
  private harnessCurrent: number | null = null;

  constructor(private readonly prices: PriceTable) {}

  add(e: RequestEvent): void {
    this.requests++;
    let m = this.byModel.get(e.model);
    if (!m) {
      m = { usd: 0, usage: zeroUsage() };
      this.byModel.set(e.model, m);
    }
    if (e.usage === null) {
      this.missingUsage++;
      return;
    }
    addUsage(this.usage, e.usage);
    addUsage(m.usage, e.usage);
    const price = lookupPrice(this.prices, e.model);
    const issue = price !== null ? modifierIssue(e.usage, price) : null;
    if (issue !== null) {
      this.unpricedModifier++;
      this.unpricedModifiers.add(`${e.model} ${issue}`);
      return;
    }
    if (price?.writesApproximate && e.usage.cacheWrite5m + e.usage.cacheWrite1h > 0) this.approxWrites++;
    const cost = requestCost(e.usage, price);
    if (cost === null) {
      this.unpriced++;
      this.unpricedModels.add(e.model);
      return;
    }
    this.usd += cost;
    m.usd += cost;
  }

  /** cost-state totals only grow within one Claude Code process; a drop means a new process started. */
  addHarnessCost(totalCostUSD: number): void {
    if (this.harnessCurrent !== null && totalCostUSD < this.harnessCurrent) this.harnessDone += this.harnessCurrent;
    this.harnessCurrent = totalCostUSD;
  }

  result(): CostSummary {
    const u = this.usage;
    const promptTotal = u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;
    const harnessUSD = this.harnessCurrent === null ? null : this.harnessDone + this.harnessCurrent;
    let unloggedUSD: number | null = null;
    let priceMismatch = false;
    if (harnessUSD !== null && this.unpriced === 0 && this.missingUsage === 0 && this.unpricedModifier === 0) {
      unloggedUSD = harnessUSD - this.usd;
      if (unloggedUSD < 0) {
        if (-unloggedUSD <= MISMATCH_TOLERANCE * harnessUSD) unloggedUSD = 0;
        else priceMismatch = true;
      }
    }
    return {
      usd: this.usd,
      requests: this.requests,
      requestsMissingUsage: this.missingUsage,
      requestsUnpriced: this.unpriced,
      unpricedModels: [...this.unpricedModels].sort(),
      requestsUnpricedModifier: this.unpricedModifier,
      unpricedModifiers: [...this.unpricedModifiers].sort(),
      requestsApproxWritePrice: this.approxWrites,
      byModel: new Map([...this.byModel].map(([k, v]) => [k, { usd: v.usd, usage: { ...v.usage } }])),
      usage: { ...u },
      cacheHitShare: promptTotal > 0 ? u.cacheRead / promptTotal : null,
      harnessUSD,
      unloggedUSD,
      priceMismatch,
    };
  }
}
