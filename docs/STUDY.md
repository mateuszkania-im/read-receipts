# Validation study: what we measured

This page explains how far you can trust the read numbers in a `read-receipts` report. It covers the corpus, how reads were sampled and labelled, the error rates of the read heuristic, the kinds of mistakes it makes, and what is still missing. The definitions it tests are in [spec section 6.3](superpowers/specs/2026-11-01-agent-ledger-design.md#63-reads-and-unreferenced-reads), and the study protocol is in [spec section 11](superpowers/specs/2026-11-01-agent-ledger-design.md#11-validation-study-what-we-measured).

The numbers in the generated blocks below are written by `node study/aggregate.mjs` and `node study/score.mjs --write`. Nothing on this page was estimated before those scripts ran.

## The question

For every file the agent read, `read-receipts` decides whether something the agent did later refers back to it: an edit of the file, a mention of its path, an identifier declared in it, or (for test files) a test title or an edit of the module under test. Reads with no such reference are called **unreferenced**. The study asks two things:

1. Of the reads called unreferenced, how many were really unused? (precision)
2. Of the reads called referenced, how many were in fact unused? (the miss rate of "referenced")

Recall (of all unused reads, how many the heuristic calls unreferenced) is not published; the Recall section below says why.

## Method

**Corpus.** Only sessions whose working directory is inside one of four public repos on the author's machine: [`why-diff`](https://github.com/mateuszkania-im/why-diff) (with its `bench/runs/*` sandboxes), [`doc-router`](https://github.com/mateuszkania-im/doc-router), [`recipe-units-agent`](https://github.com/mateuszkania-im/recipe-units-agent) and `agent-ledger` (this tool's own repo, published with this release). The list is in [`study/allowlist.json`](../study/allowlist.json), and the study scripts refuse any other session. Every session is a Claude Code session, started from the Python SDK (`sdk-py`) or from the CLI in headless mode (`sdk-cli`). None is an interactive session. Most are automated code-review and benchmark runs.

**Two repos removed after labelling.** When the samples were drawn, the allowlist also held two local repos that turned out not to be public. Their reads were sampled and labelled with the rest. Before publication the 2 labels from them (1 in the first sample, 1 in the held-out sample) were deleted, without re-labelling anything, and every number on this page was scored again without them. The sampling-time counts in the next paragraph still include those two repos: at sampling time the corpus had 338 sessions with 251 file reads; 5 reads of files outside the repo and 1 read matching a private-marker deny list were left out, which left 245 candidates.

**Sampling.** [`study/sample-reads.mjs`](../study/sample-reads.mjs) draws a stratified random sample with a fixed seed (20261102): 150 reads, at most 3 per session, spread over the repos in proportion to their reads, and stratified by the heuristic's call so that both classes have support. That took every unreferenced read in the corpus (72, now 71 without the removed repos) and 78 referenced reads, so the referenced class was subsampled and the unreferenced class was not. For each read it writes a packet with the content of the read and every later event in the same thread, with tool results cut to 400 characters. A fail-closed filter drops any later call that reaches outside the repo. Packets contain no heuristic output.

**Rubric.** [`study/RUBRIC.md`](../study/RUBRIC.md): **used** if anything the agent did later depends on the content of the read (it edited the file, cited it, acted on a fact or identifier from it, or stated a conclusion that depends on it, including ruling a hypothesis out); **unused** if nothing later depends on it; **unclear** if the packet cannot decide.

**Labeller.** Reads were labelled by an LLM reviewer with a written rubric, blind to the heuristic. The labeller was a separate agent with a fresh context. It saw only the rubric and the packets, never the predictions, the heuristic's code or the plan. Labels are in [`study/labels.jsonl`](../study/labels.jsonl): session hash, read number, repo, repo-relative path, label and a short reason, with no file content.

**Two heuristic versions.** v1 is the heuristic as it was when the first sample was labelled. Reading its disagreements with the labels led to two rules for test files (rules 4 and 5 in spec 6.3); with them it is v2, the current version. Because those rules came from the first labels, v2 cannot be validated on them. v2 only ever turns an unreferenced read into a referenced one, so on the first sample it keeps every true positive and drops false positives: the blind v1 precision is a lower bound for v2 there. The report's "likely unused" estimate uses the v1 figure for that reason.

**Held-out sample.** [`study/sample-heldout.mjs`](../study/sample-heldout.mjs) drew 90 more reads (89 after the removal) with a different seed (20261103) from the reads not in the first sample. The first sample had already taken every unreferenced read, so the held-out reads are all reads that both v1 and v2 call referenced. A fresh blind labeller labelled them with the same rubric ([`study/labels-heldout.jsonl`](../study/labels-heldout.jsonl)). While batching, this labeller by mistake appended a few packets from outside the held-out set (session hashes 28d0cb0e20a6, 2a863ff213ef and 2c0edcb626c8, all from the first sample) and saw part of their content, but it saw no predictions and none of those packets fed into any label.

**Scoring.** [`study/score.mjs`](../study/score.mjs) joins labels with predictions by session hash and read number. Positive class: unreferenced (heuristic) and unused (label). Precision = TP / (TP + FP). The miss rate of "referenced" = unused / (used + unused) over reads the heuristic calls referenced. `unclear` labels are left out of the ratios and counted. Intervals are 95% Wilson score intervals. The counts are saved in [`study/results.json`](../study/results.json), and CI checks that the blocks below match them.

## Results

<!-- SCORES:START -->
#### First sample, heuristic v1 (blind)

149 reads labelled: 13 unused, 103 used, 33 unclear. Positive class: unreferenced (metric) and unused (label).

| | label unused | label used | label unclear |
|---|---|---|---|
| metric unreferenced | 11 | 33 | 27 |
| metric referenced | 2 | 70 | 6 |

- Precision: 25.0% (11 of 44, 95% CI 14.6% to 39.4%)
- Miss rate of "referenced" in this sample: 2 of 72 (2.8%, 95% CI 0.8% to 9.6%)

#### First sample, heuristic v2 (development set, not a validation)

The test-file rules of v2 were written after reading these disagreements, so this figure is a development set number and is never used as the estimate.

| | label unused | label used | label unclear |
|---|---|---|---|
| metric unreferenced | 11 | 24 | 25 |
| metric referenced | 2 | 79 | 8 |

- Precision: 31.4% (11 of 35, 95% CI 18.6% to 48.0%)

#### Held-out sample, reads both versions call referenced (blind)

89 reads labelled: used 78, unused 3, unclear 8.

- Miss rate of "referenced": 3.7% (3 of 81, 95% CI 1.3% to 10.3%)

#### Recall

Recall is not published. The first sample was stratified: it took every read the heuristic calls unreferenced but only a subsample of the referenced ones, so recall cannot be estimated without reweighting by those sampling fractions, and an unweighted figure would overstate it.
<!-- SCORES:END -->

### How to read these numbers

- **"Referenced" is a reliable signal of use.** On both samples well over nine in ten referenced reads with a clear label were used.
- **"Unreferenced" is an upper bound, not wasted.** Most unreferenced reads with a clear label were in fact used, usually in a way no word-matching rule can see (below). That is why the report shows "likely unused" as an estimate next to the unreferenced count and never calls unreferenced reads waste. Its range is the precision CI scaled by the count, not a 95% interval for the count itself.
- **No recall.** An unweighted recall from the first sample (11 of 13) would overstate it, because that sample took every unreferenced read but under half of the referenced ones.

## Where the heuristic goes wrong

The 35 disagreements between v1 and the first-sample labels (public repos only), sorted by hand into categories. Each was checked against its packet and label reason; no file content is reproduced here.

| Category | Kind | Count |
|---|---|---|
| Use shows only as a prose paraphrase in a final review verdict: no path, no identifier, the agent summarises what the code does or judges it safe | false positive | 15 |
| Test file read before a fix: use shows as test titles, expected values or line numbers, never as a declared identifier (fixed in v2 by rules 4 and 5) | false positive | 10 |
| The agent names an identifier from the file, but the anchor rules drop it (a one-word name, a member of a one-word type, a plain JSON key) | false positive | 4 |
| The file is named by a short form the path rules ignore (a basename under 6 characters, or a module name without folder and extension) | false positive | 2 |
| The path is named later, but for another part of a large file than the range this read covered | false negative | 2 |
| The agent uses an identifier that appears in the file but is declared elsewhere | false positive | 1 |
| A verifier verdict (which findings survived) whose one-line rationale paraphrases the read | false positive | 1 |

16 of the 33 false positives come from headless review sessions that end with a one-paragraph verdict. The same session shape produces most of the unclear labels. No lexical rule can tie a paraphrase to the read it came from; this is the documented limit in spec 6.3, and the reason unreferenced is reported as an upper bound.

## What we measured on the corpus

`read-receipts --json --share` over the same four public repos, totals only, written by [`study/aggregate.mjs`](../study/aggregate.mjs) to [`study/aggregate.json`](../study/aggregate.json). This is one developer's public-repo sessions, mostly headless review and benchmark runs, not a sample of how people use coding agents. The corpus has grown a little since sampling, so its read count differs from the sampling-time count above. No "likely unused" estimate is given here: these reads were labelled, so the labelled counts are shown instead.

<!-- AGGREGATE:START -->
Run on 2026-11-02 with read-receipts 0.1.0, `--share`, over the allowlisted repos only. Totals only.

| Measure | Value |
|---|---|
| Sessions | 351 |
| Entrypoints | sdk-py 271, sdk-cli 80 |
| Requests | 925 |
| Cost computed from token usage | $43.42 |
| Claude Code's own cost record (351 sessions have one) | $44.18, gap $0.76 |
| Cache hit share of input tokens | 73.7% |
| Reads | 268 |
| Unreferenced reads | 72 (26.9%) |
| Unreferenced share of read tokens (≈) | 28.2% |
| Cost of carrying unreferenced reads (≈) | $0.48 |
| Labelled reads the heuristic calls unreferenced (first sample, v2) | 60: 11 unused, 24 used, 25 unclear |
| Re-reads | 15 (5.6%), 14 unchanged |
| Compactions | 0 |
| Subagents | 0 |
| Largest context sources (introduced, ≈) | tool_schemas 35.1%, user_prompt 34.5%, system_prompt 11.4%, assistant_output 8.7%, tool_result:Read 5.3%, other 2.5% |
<!-- AGGREGATE:END -->

## Limits

- **Headless review sessions dominate.** Every session is an SDK or headless CLI run, mostly code reviews and small benchmark tasks. Interactive sessions, long refactors and other developers' habits may give different error rates.
- **No Codex reads.** The corpus has no Codex sessions, so the Codex parser's read numbers are not validated. Its tests use synthetic fixtures.
- **Few unused labels.** Only 13 reads in the first sample and 3 in the held-out sample were labelled unused, so the intervals are wide.
- **No held-out precision.** The first sample took every unreferenced read in the corpus, so no unreferenced read was left for a held-out set. Precision of "unreferenced" is known only from the first sample (v1, blind) and as a development figure (v2).
- **No recall.** The samples were stratified by the heuristic's call, so recall would need reweighting by the sampling fractions; it is not published.
- **No compactions or subagents.** None of these sessions compacted or started a subagent, so the compaction re-read rate and subagent attribution were not exercised here.
- **The labeller is an LLM.** Its labels follow a written rubric but were not checked against human labels.

## Next steps

- A held-out precision sample from new sessions. At the unreferenced rate seen here that needs about 200 new public-repo sessions to yield about 40 unreferenced reads to label.
- More varied sessions: interactive work, Codex, sessions with compactions and subagents.

Contributions are welcome. If you have public-repo sessions you can share, or want to label packets with the rubric, open an issue.
