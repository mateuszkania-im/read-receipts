// Spec 6.3 and 11: the validation study's numbers, fixed at build time. "Unreferenced" is an upper bound on
// unused reads; the report scales it by a measured precision to give a labelled estimate. With STUDY set
// to null the report leaves the line out.

export interface StudyNumbers {
  /** Precision of "unreferenced" against "unused" labels (unclear excluded): unused / calledUnreferenced. */
  precision: number;
  /** 95% Wilson interval of that precision. */
  ci: [number, number];
  /** Reads called unreferenced and labelled unused, and all reads called unreferenced with a clear label. */
  unused: number;
  calledUnreferenced: number;
  /** Reads called unreferenced whose label was unclear (left out of the precision). */
  unclear: number;
  /** Which sample the precision comes from, as shown in the report. */
  sample: string;
  /** Reads called referenced that were labelled unused, over those with a clear label, with its 95% Wilson interval. */
  missRate: { rate: number; ci: [number, number]; unused: number; scored: number; sample: string };
  date: string;
}

/**
 * From study/score.mjs and study/results.json (spec 11.6), public repos only. Precision: blind labels of
 * the first sample against heuristic v1, before the test-file rules (6.3 rules 4 and 5): 11 of 44 reads
 * called unreferenced were unused, 27 more unclear. v2 only turns unreferenced reads into referenced
 * ones and is at least as precise on that set, so this is a conservative precision for the current
 * heuristic. Miss rate: the held-out sample of reads both versions call referenced, 3 of 81 unused.
 * Recall is not published: the first sample took every unreferenced read but only some referenced ones.
 */
export const STUDY: StudyNumbers | null = {
  precision: 11 / 44,
  ci: [0.14574213828964888, 0.3944056635895915],
  unused: 11,
  calledUnreferenced: 44,
  unclear: 27,
  sample: 'blind labels, heuristic v1 before test-file rules 4 and 5, so conservative for the current heuristic',
  missRate: { rate: 3 / 81, ci: [0.012675114183298107, 0.10332311306893818], unused: 3, scored: 81, sample: 'held-out sample, blind' },
  date: '2026-11-02',
};

export interface LikelyUnused {
  estimated: true;
  /** Estimated number of unused reads. */
  count: number;
  /** The range scaled from the precision CI: the low end rounded down, the high end up. */
  low: number;
  high: number;
  precision: number;
  ci: [number, number];
  sample: string;
}

/** likely unused ≈ unreferenced × precision, with the precision CI scaled the same way; null without study numbers. */
export function likelyUnused(unreferencedReads: number, study: StudyNumbers | null = STUDY): LikelyUnused | null {
  if (study === null || unreferencedReads <= 0) return null;
  return {
    estimated: true,
    count: Math.round(unreferencedReads * study.precision),
    low: Math.floor(unreferencedReads * study.ci[0]),
    high: Math.ceil(unreferencedReads * study.ci[1]),
    precision: study.precision,
    ci: [study.ci[0], study.ci[1]],
    sample: study.sample,
  };
}

const pc = (x: number) => `${(x * 100).toFixed(1)}%`;

/** The method note every report carries about the study (spec 6.3). Same statements as README and docs/STUDY.md. */
export function studySentence(study: StudyNumbers | null = STUDY): string {
  if (study === null) return 'Precision of the unreferenced heuristic: not measured yet (validation study pending).';
  const m = study.missRate;
  return (
    `Precision of "unreferenced" against blind labels: ${pc(study.precision)} (95% CI ${pc(study.ci[0])} to ${pc(study.ci[1])}): ` +
    `${study.unused} of ${study.calledUnreferenced} reads called unreferenced were unused, ${study.unclear} more unclear (${study.sample}). ` +
    `Unreferenced is an upper bound on unused reads. Miss rate of "referenced": ${pc(m.rate)} (95% CI ${pc(m.ci[0])} to ${pc(m.ci[1])}): ` +
    `${m.unused} of ${m.scored} reads called referenced were unused (${m.sample}). ` +
    "Recall is not published: the labelled sample was stratified by the heuristic's call, so recall cannot be estimated without reweighting."
  );
}
