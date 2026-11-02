export interface Label {
  sessionHash: string;
  readOrdinal: number;
  repo: string;
  path: string;
  label: 'used' | 'unused' | 'unclear';
  reason: string;
}
export interface Score {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  unclear: number;
  unclearUnreferenced: number;
  unmatched: number;
  precision: number;
  recall: number;
  precisionCI: [number, number];
  recallCI: [number, number];
}
export const LABEL_FIELDS: string[];
export const LABELS: string[];
export const REPOS: string[];
export function wilson(k: number, n: number, z?: number): [number, number];
export function validateLabel(l: unknown): string[];
export function readLabels(file: string): Promise<Label[]>;
export function readPredictions(file: string, version?: string): Promise<Map<string, boolean>>;
export function score(labels: Label[], predictions: Map<string, boolean>): Score;
export interface Reliability {
  referenced: number;
  used: number;
  unused: number;
  unclear: number;
  unmatched: number;
  share: number;
  ci: [number, number];
  missRate: number;
  missCI: [number, number];
}
export interface StudyResults {
  first: Score & { labels: number };
  dev: Score & { labels: number };
  heldout: Reliability & { labels: number };
}
export function referencedReliability(labels: Label[], predictions: Map<string, boolean>): Reliability;
export function replaceBlock(text: string, name: string, body: string): string;
export function renderReadmeBlock(results: StudyResults, agg: unknown): string;
export function renderStudyScores(results: StudyResults): string;
export function renderAggregate(agg: unknown, results: StudyResults): string;
export function staleBlocks(docs: { readme: string; study: string }, results: StudyResults, agg: unknown): string[];
export function computeStudy(dir?: string): Promise<StudyResults>;
