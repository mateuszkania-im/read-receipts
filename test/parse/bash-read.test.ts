import { describe, expect, it } from 'vitest';
import { bashReadLines, detectBashEdit, detectBashRead, detectBashReadSpec } from '../../src/parse/bash-read.js';

describe('detectBashRead', () => {
  it.each([
    ['cat src/a.ts', 'src/a.ts'],
    ["sed -n '1,40p' src/a.ts", 'src/a.ts'],
    ['head -50 README.md', 'README.md'],
    ['head -n 20 src/a.ts', 'src/a.ts'],
    ['tail -n 5 "logs/out file.txt"', 'logs/out file.txt'],
    ['nl src/a.ts', 'src/a.ts'],
    ['less src/a.ts', 'src/a.ts'],
    ['cat -n src/a.ts', 'src/a.ts'],
    ['/bin/cat src/a.ts', 'src/a.ts'],
    ['cat a.ts | grep x', null],
    ['cat src/*.ts', null],
    ['cat a.ts b.ts', null],
    ['ls src', null],
    ['sed s/a/b/ src/a.ts', null],
    ['cat a.ts 2>/dev/null', 'a.ts'],
    ['head -n 20 src/a.ts 2>&1', 'src/a.ts'],
    ['cat a.ts && echo done', null],
    ['cat a.ts > b.ts', null],
    ['cat $(ls)', null],
    ['cat', null],
    ['', null],
  ])('%s gives %s', (cmd, want) => expect(detectBashRead(cmd)).toBe(want));
});

describe('detectBashReadSpec: line ranges', () => {
  it.each([
    ['cat src/a.ts', { kind: 'all' }],
    ['nl src/a.ts', { kind: 'all' }],
    ["sed -n '10,20p' src/a.ts", { kind: 'lines', start: 10 }],
    ["sed -n '7p' src/a.ts", { kind: 'lines', start: 7 }],
    ["sed -n '5,$p' src/a.ts", { kind: 'lines', start: 5 }],
    ["sed -n '/foo/p' src/a.ts", { kind: 'unknown' }],
    ['head -n 20 src/a.ts', { kind: 'head', n: 20 }],
    ['head -50 src/a.ts', { kind: 'head', n: 50 }],
    ['head src/a.ts', { kind: 'head', n: 10 }],
    ['head -c 100 src/a.ts', { kind: 'unknown' }],
    ['tail -n 5 src/a.ts', { kind: 'tail', n: 5 }],
    ['tail -5 src/a.ts', { kind: 'tail', n: 5 }],
    ['tail src/a.ts', { kind: 'tail', n: 10 }],
    ['tail -n +30 src/a.ts', { kind: 'lines', start: 30 }],
    ['tail -f src/a.ts', { kind: 'unknown' }],
  ])('%s gives %o', (cmd, range) => expect(detectBashReadSpec(cmd)).toEqual({ path: 'src/a.ts', range }));
});

describe('bashReadLines', () => {
  const five = 'a\nb\nc\nd\ne\n';
  it('a whole-file read knows the file length', () => {
    expect(bashReadLines({ kind: 'all' }, five)).toEqual({ startLine: 1, numLines: 5, totalLines: 5 });
  });
  it('a sed range starts at its first line', () => {
    expect(bashReadLines({ kind: 'lines', start: 10 }, five)).toEqual({ startLine: 10, numLines: 5, totalLines: null });
  });
  it('head shorter than asked means the whole file', () => {
    expect(bashReadLines({ kind: 'head', n: 20 }, five)).toEqual({ startLine: 1, numLines: 5, totalLines: 5 });
    expect(bashReadLines({ kind: 'head', n: 5 }, five)).toEqual({ startLine: 1, numLines: 5, totalLines: null });
  });
  it('tail is approximate until the file length is known', () => {
    expect(bashReadLines({ kind: 'tail', n: 5 }, five)).toEqual({ startLine: 1, numLines: 5, totalLines: null, approximate: true, fromEnd: 5 });
    expect(bashReadLines({ kind: 'tail', n: 9 }, five)).toEqual({ startLine: 1, numLines: 5, totalLines: 5 });
  });
  it('anything else starts at line 1 and is approximate', () => {
    expect(bashReadLines({ kind: 'unknown' }, five)).toEqual({ startLine: 1, numLines: 5, totalLines: null, approximate: true });
  });
});

describe('sed -i is an edit', () => {
  it.each([["sed -n -i 's/a/b/' f.ts"], ["sed -i 's/a/b/' f.ts"], ["sed -i.bak -n '1p' f.ts"], ["sed --in-place -n '1p' f.ts"]])('%s is not a read', (cmd) => {
    expect(detectBashRead(cmd)).toBeNull();
  });
  it.each([
    ["sed -i 's/a/b/' src/a.ts", ['src/a.ts']],
    ["sed -i '' -e 's/a/b/' src/a.ts src/b.ts", ['src/a.ts', 'src/b.ts']],
    ["sed -n -i.bak 's/a/b/p' f.ts", ['f.ts']],
    ["sed 's/a/b/' f.ts", null],
    ["sed -i 's/a/b/' src/*.ts", null],
    ['cat f.ts', null],
  ])('%s edits %o', (cmd, want) => expect(detectBashEdit(cmd)).toEqual(want));
});
