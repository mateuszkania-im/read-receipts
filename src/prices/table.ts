// Price table (spec section 6.1). Defaults ship inside the bundle; `--prices <file.json>` merges over them.

import { readFile } from 'node:fs/promises';
import type { Usage } from '../model.js';
import defaults from './defaults.json' with { type: 'json' };

/** Prices in USD per million tokens. */
export interface TierPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

export interface ModelPrice extends TierPrice {
  source: string;
  retrieved: string;
  /** Prices for a request whose whole prompt (input + cache reads + cache writes) is over `aboveInputTokens`. */
  longContext?: TierPrice & { aboveInputTokens: number };
  note?: string;
  /** Fast mode input and output prices; cache prices scale with the input price (vendor page, fast mode pricing). */
  fast?: { input: number; output: number };
  /** Multiplier on every price for `inference_geo: "us"` (Claude 4.6 and later: 1.1). */
  usGeoMultiplier?: number;
  /** The page gives no cache write price for this model, so writes are priced at the input price: approximate. */
  writesApproximate?: boolean;
}

export type PriceTable = Map<string, ModelPrice>;

const PRICE_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h'] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function priceNumber(v: unknown, model: string, key: string, where: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    throw new Error(`${where}: "${model}".${key} must be a non-negative number`);
  }
  return v;
}

function parseTier(v: unknown, model: string, where: string): (TierPrice & { aboveInputTokens: number }) | undefined {
  if (v === undefined) return undefined;
  if (!isRecord(v)) throw new Error(`${where}: "${model}".longContext must be an object`);
  const tier = { aboveInputTokens: priceNumber(v.aboveInputTokens, model, 'longContext.aboveInputTokens', where) } as TierPrice & {
    aboveInputTokens: number;
  };
  for (const k of PRICE_KEYS) tier[k] = priceNumber(v[k], model, `longContext.${k}`, where);
  return tier;
}

/**
 * Merges one entry over `base` (or creates it). A new model needs every price field; an existing one
 * may change any subset. Merged entries take the override file as their source.
 */
function mergeEntry(base: ModelPrice | undefined, model: string, raw: unknown, where: string, source: string, retrieved: string): ModelPrice {
  if (!isRecord(raw)) throw new Error(`${where}: "${model}" must be an object`);
  const out = { ...base } as ModelPrice;
  for (const k of PRICE_KEYS) {
    if (raw[k] !== undefined) out[k] = priceNumber(raw[k], model, k, where);
    else if (base === undefined) throw new Error(`${where}: new model "${model}" needs ${k}`);
  }
  const tier = parseTier(raw.longContext, model, where);
  if (tier) out.longContext = tier;
  if (raw.fast !== undefined) {
    if (!isRecord(raw.fast)) throw new Error(`${where}: "${model}".fast must be an object`);
    out.fast = { input: priceNumber(raw.fast.input, model, 'fast.input', where), output: priceNumber(raw.fast.output, model, 'fast.output', where) };
  }
  if (raw.usGeoMultiplier !== undefined) out.usGeoMultiplier = priceNumber(raw.usGeoMultiplier, model, 'usGeoMultiplier', where);
  if (raw.writesApproximate !== undefined) out.writesApproximate = raw.writesApproximate === true;
  out.source = typeof raw.source === 'string' ? raw.source : source;
  out.retrieved = typeof raw.retrieved === 'string' ? raw.retrieved : retrieved;
  if (typeof raw.note === 'string') out.note = raw.note;
  return out;
}

function modelsOf(doc: unknown, where: string): Array<[string, unknown]> {
  if (!isRecord(doc)) throw new Error(`${where}: expected a JSON object`);
  const models = isRecord(doc.models) ? doc.models : doc;
  return Object.entries(models).filter(([k]) => k !== 'about');
}

function defaultTable(): PriceTable {
  const t: PriceTable = new Map();
  for (const [model, raw] of modelsOf(defaults, 'defaults.json')) {
    t.set(model, mergeEntry(undefined, model, raw, 'defaults.json', '', ''));
  }
  return t;
}

/**
 * Loads the default table, then merges `overridePath` over it. The override is `{ "<model>": { ...prices } }`
 * or `{ "models": { ... } }`; prices it changes get the file path as their source and today as their date.
 */
export async function loadPriceTable(overridePath: string | null): Promise<PriceTable> {
  const t = defaultTable();
  if (overridePath === null) return t;
  const doc: unknown = JSON.parse(await readFile(overridePath, 'utf8'));
  const today = new Date().toISOString().slice(0, 10);
  for (const [model, raw] of modelsOf(doc, overridePath)) {
    t.set(model, mergeEntry(t.get(model), model, raw, overridePath, overridePath, today));
  }
  return t;
}

/**
 * What may follow a table id in a longer model id without naming another model: a release date
 * (`-20250514`, `@20250514`, `-2025-08-07`), a context tag (`[1m]`), a provider version (`-v1:0`, `:0`)
 * or `-latest`, in any sequence. Anything else after the id (`-9`, `-mini`, `-codex`, `.9`) is a
 * version or a variant the table does not list, so the id is unpriced, never guessed.
 */
const NON_VERSION_SUFFIX = /^(?:[-@]\d{8}|-\d{4}-\d{2}-\d{2}|\[[0-9A-Za-z]+\]|-v\d+(?::\d+)?|:\d+|-latest)+$/;

/** Exact id, then the longest table id followed only by a non-version suffix; else null (unpriced). */
export function lookupPrice(table: PriceTable, model: string): ModelPrice | null {
  const exact = table.get(model);
  if (exact) return exact;
  let best: ModelPrice | null = null;
  let bestLen = 0;
  for (const [id, price] of table) {
    if (id.length > bestLen && id.length < model.length && model.startsWith(id) && NON_VERSION_SUFFIX.test(model.slice(id.length))) {
      best = price;
      bestLen = id.length;
    }
  }
  return best;
}

export function promptTokens(u: Usage): number {
  return u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;
}

/** Values of the modifiers that mean standard pricing. */
const STANDARD_SPEED = new Set(['', 'standard']);
const STANDARD_GEO = new Set(['', 'global', 'not_available']);

/**
 * Why a request cannot be priced from the table although its model can: a fast-mode or `inference_geo`
 * value the table has no price for (`speed=fast`, `inference_geo=eu`), else null.
 */
export function modifierIssue(usage: Usage, price: ModelPrice): string | null {
  const speed = usage.speed;
  if (speed !== undefined && !STANDARD_SPEED.has(speed) && !(speed === 'fast' && price.fast)) return `speed=${speed}`;
  const geo = usage.inferenceGeo;
  if (geo !== undefined && !STANDARD_GEO.has(geo) && !(geo === 'us' && price.usGeoMultiplier !== undefined)) return `inference_geo=${geo}`;
  return null;
}

/** The tier a request is priced at: long context, fast mode (cache prices scaled with input), US geography. */
function tierFor(usage: Usage, price: ModelPrice): TierPrice {
  let p: TierPrice;
  if (usage.speed === 'fast' && price.fast) {
    const k = price.fast.input / price.input;
    p = { input: price.fast.input, output: price.fast.output, cacheRead: price.cacheRead * k, cacheWrite5m: price.cacheWrite5m * k, cacheWrite1h: price.cacheWrite1h * k };
  } else {
    p = price.longContext && promptTokens(usage) > price.longContext.aboveInputTokens ? price.longContext : price;
  }
  const g = usage.inferenceGeo === 'us' ? (price.usGeoMultiplier ?? 1) : 1;
  return g === 1 ? p : { input: p.input * g, output: p.output * g, cacheRead: p.cacheRead * g, cacheWrite5m: p.cacheWrite5m * g, cacheWrite1h: p.cacheWrite1h * g };
}

/** Spec 6.1: cost of one request in USD, or null when usage, price or a modifier's price is missing. */
export function requestCost(usage: Usage | null, price: ModelPrice | null): number | null {
  if (usage === null || price === null || modifierIssue(usage, price) !== null) return null;
  const p = tierFor(usage, price);
  return (
    (usage.input * p.input +
      usage.output * p.output +
      usage.cacheRead * p.cacheRead +
      usage.cacheWrite5m * p.cacheWrite5m +
      usage.cacheWrite1h * p.cacheWrite1h) /
    1e6
  );
}

/** Cache write and read prices of one request (for carried cost), or null when it cannot be priced. */
export function cachePrices(usage: Usage, price: ModelPrice): { write5m: number; write1h: number; read: number } | null {
  if (modifierIssue(usage, price) !== null) return null;
  const p = tierFor(usage, price);
  return { write5m: p.cacheWrite5m, write1h: p.cacheWrite1h, read: p.cacheRead };
}
