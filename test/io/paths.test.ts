import { describe, expect, it } from 'vitest';
import { normalizePath, toRepoRelative } from '../../src/io/paths.js';

describe('normalizePath / toRepoRelative', () => {
  it.each([
    ['./src/a.ts', '/r', 'src/a.ts'],
    ['/r/src/../src/a.ts', '/r', 'src/a.ts'],
    ['C:\\r\\src\\a.ts', 'C:/r', 'src/a.ts'],
  ])('normalises %s under %s to %s', (p, root, want) => {
    expect(toRepoRelative(normalizePath(p, 'win32'), normalizePath(root, 'win32')).path).toBe(want);
  });

  it('treats /private/tmp and /tmp as one path on darwin', () => {
    expect(normalizePath('/private/tmp/x/a.ts', 'darwin')).toBe(normalizePath('/tmp/x/a.ts', 'darwin'));
    expect(normalizePath('/private/var/x/a.ts', 'darwin')).toBe('/var/x/a.ts');
  });

  it('does not map /private/tmp on linux', () => {
    expect(normalizePath('/private/tmp/x/a.ts', 'linux')).toBe('/private/tmp/x/a.ts');
  });

  it('marks paths outside the repo', () => {
    expect(toRepoRelative('/etc/hosts', '/r')).toEqual({ path: '/etc/hosts', inRepo: false });
  });

  it('does not treat a sibling with a shared prefix as inside the repo', () => {
    expect(toRepoRelative('/repo-other/a.ts', '/repo')).toEqual({ path: '/repo-other/a.ts', inRepo: false });
  });

  it('keeps a relative input as in-repo and returns absolute paths unchanged without a root', () => {
    expect(toRepoRelative('src/a.ts', null)).toEqual({ path: 'src/a.ts', inRepo: true });
    expect(toRepoRelative('/x/a.ts', null)).toEqual({ path: '/x/a.ts', inRepo: false });
  });

  it('drops a trailing slash and is case-insensitive only on win32', () => {
    expect(normalizePath('/R/Src/', 'linux')).toBe('/R/Src');
    expect(normalizePath('C:\\R\\Src\\A.ts', 'win32')).toBe('c:/r/src/a.ts');
  });

  it('maps the repo root itself to "."', () => {
    expect(toRepoRelative('/r', '/r')).toEqual({ path: '.', inRepo: true });
  });
});

describe('normalizePath: Windows spellings', () => {
  it('keeps the UNC prefix', () => {
    expect(normalizePath('\\\\server\\share\\a.ts', 'win32')).toBe('//server/share/a.ts');
    expect(normalizePath('//server/share/../share/a.ts', 'win32')).toBe('//server/share/a.ts');
  });
  it('maps MSYS /c/... to c:/...', () => {
    expect(normalizePath('/c/Users/Dev/a.ts', 'win32')).toBe('c:/users/dev/a.ts');
    expect(normalizePath('/c', 'win32')).toBe('c:');
    expect(normalizePath('/c/x', 'linux')).toBe('/c/x');
    expect(normalizePath('/cd/x', 'win32')).toBe('/cd/x');
  });
});
