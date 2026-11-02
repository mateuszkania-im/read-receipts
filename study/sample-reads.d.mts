export interface Allowlist {
  parents: string[];
  repos: string[];
}
export interface Candidate {
  sessionHash: string;
  readOrdinal: number;
  repo: string;
  path: string;
  tool: 'read' | 'bash' | 'codex';
  threadId: string;
  seq: number;
  unreferenced: boolean;
  reason: 'edit' | 'path' | 'symbol' | 'edit-subject' | null;
}
export interface CorpusOptions {
  claudeDir: string | null;
  codexDir: string | null;
  allowlist: Allowlist;
  home: string;
  deny: string[];
}
export interface Corpus {
  sessions: number;
  refusedSessions: number;
  readsOutsideRepo: number;
  readsDenied: number;
  totalReads: number;
  byEntrypoint: Record<string, number>;
  byRepo: Record<string, number>;
  candidates: Candidate[];
}
export const SEED: number;
export const DEFAULT_TARGET: number;
export const PER_SESSION_CAP: number;
export const TOOL_FLOOR: number;
export function loadAllowlist(file: string): Promise<Allowlist>;
export function allowedRoot(cwd: string | null, allowlist: Allowlist, home: string): string | null;
export interface CallLike {
  tool: string;
  toolClass: string;
  paths: string[];
  text: string;
  command?: string;
}
export function callTouchesOutside(call: CallLike, raw: string | undefined, ctx: { root: string; home: string; cwd: string | null; agent: 'claude' | 'codex' }): boolean;
export function touchesOutside(text: string, ctx: { root: string; home: string }): boolean;
export function scrubText(text: string, ctx: { root: string; home: string; user?: string; deny: string[] }): string | null;
export function sessionHash(id: string): string;
export function rng(seed: number): () => number;
export function collectCorpus(opts: CorpusOptions): Promise<Corpus>;
export function drawSample(candidates: Candidate[], target: number, seed?: number): Candidate[];
export function runSample(
  opts: CorpusOptions & {
    outDir: string;
    target?: number;
    seed?: number;
    user?: string;
    /** Narrows the candidates before drawing (e.g. a held-out pool). */
    select?: (candidates: Candidate[]) => Candidate[];
    /** Packet folder and predictions file under outDir; default `packets` and `predictions.json`. */
    packetsName?: string;
    predictionsName?: string;
    /** What predictions.json stores per read; never written into a packet. */
    predictionOf?: (c: Candidate) => unknown;
  },
): Promise<{ packets: number; strata: Record<string, number>; corpus: Record<string, unknown> }>;
export function devPredictions(
  candidates: readonly Pick<Candidate, 'sessionHash' | 'readOrdinal' | 'repo' | 'unreferenced' | 'reason'>[],
  firstPredictions: Record<string, { repo: string }>,
): Record<string, { v2: { unreferenced: boolean; reason: Candidate['reason'] }; repo: string }>;
