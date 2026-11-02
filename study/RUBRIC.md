# Labelling rubric: was the content of this read used later?

You get one packet per file read by a coding agent. Each packet has a header (`sessionHash`, `readOrdinal`, `repo`, `path`), the content of the read (possibly cut), and what happened after the read in the same session, in order: the agent's tool calls, tool results (cut to 400 characters), assistant text, user messages and compactions.

Decide one question per packet: **did anything the agent did after this read depend on the content of this read?**

## Labels

- **used**: something after the read depends on its content. Any of these is enough:
  - the agent edited or rewrote this file;
  - the agent cited the file, a part of it, or a fact from it (in text, a command, an edit or a subagent answer);
  - the agent acted on a fact or an identifier that it can only have learned from this read: a function name, a config key, a command from a README, a value, a code shape it copied;
  - the agent stated a conclusion that depends on what it read here, including ruling a hypothesis out ("the bug is not in the parser, it already handles empty input").
- **unused**: nothing after the read depends on its content. Typical cases: the agent read the file and moved on without naming it, using anything from it, or concluding anything from it; the session ended right after the read; the agent read the same file again later and only the later read was used.
- **unclear**: the packet does not let you decide. Use it when the later events are cut off before anything decisive, when the agent's later actions could equally come from another source you cannot see (another file with the same facts, the user's message), or when the read content is cut so that you cannot tell whether a later identifier came from it.

Rules:

1. Judge only from the packet. Do not guess what the agent was "probably thinking".
2. A user message is not the agent. A user repeating facts from the file does not make the read used.
3. A later read of the same file does not by itself make this read used; look for what the agent did with the content.
4. Naming the file only to dismiss it ("`src/legacy.ts` is not relevant") is a conclusion that depends on the read: **used**.
5. Matching a word is not enough. A common word that happens to appear both in the file and later (`error`, `config`, `test`) is not use unless the later action clearly relies on this file's meaning of it.
6. When in doubt between used and unused, and the packet really cannot settle it, choose **unclear**, not a guess.

## Output

Write one JSON object per packet, one per line, to `study/labels.jsonl`:

```json
{"sessionHash":"0123456789ab","readOrdinal":7,"repo":"why-diff","path":"src/cart.ts","label":"used","reason":"Edited the file two steps later, changing cartTotal."}
```

- `sessionHash`, `readOrdinal`, `repo`, `path`: copied from the packet header.
- `label`: `used`, `unused` or `unclear`.
- `reason`: at most 200 characters, in your own words. Never quote file content, code, commands or paths other than the packet's own `path`.
- No other fields.

## Worked examples (synthetic)

### Example 1: used (a fact from the read drives an edit elsewhere)

The agent reads `src/config.ts`, which declares `export const RETRY_LIMIT = 3`. Later it edits `src/client.ts` and writes `for (let i = 0; i < RETRY_LIMIT; i++)` with an import from `./config`. It never names `src/config.ts` again.

Label: **used**. The edit relies on an identifier declared in the read.

```json
{"sessionHash":"aaaaaaaaaaaa","readOrdinal":2,"repo":"why-diff","path":"src/config.ts","label":"used","reason":"Imported a constant declared in this file into the client edit."}
```

### Example 2: unused (read, then nothing depends on it)

The agent reads `docs/CHANGELOG.md` (a list of past releases) while looking for a failing test. After the read it runs the tests, edits `src/parse.ts`, and reports "Fixed the off-by-one in parseLine". Nothing later refers to releases, the changelog or anything in it.

Label: **unused**.

```json
{"sessionHash":"bbbbbbbbbbbb","readOrdinal":5,"repo":"doc-router","path":"docs/CHANGELOG.md","label":"unused","reason":"Nothing after the read refers to the changelog or relies on its content."}
```

### Example 3: unclear (the deciding events are not in the packet)

The agent reads `src/routes.ts`. The next events are a user message and then a note that 40 more events are not shown because the packet is capped. Nothing in the visible events relates to the routes.

Label: **unclear**. Whatever happened with the file may be in the events that are not shown.

```json
{"sessionHash":"cccccccccccc","readOrdinal":1,"repo":"doc-router","path":"src/routes.ts","label":"unclear","reason":"Visible events are unrelated and the packet is cut before anything decisive."}
```
