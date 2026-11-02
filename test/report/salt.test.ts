import { chmod, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadOrCreateSalt, parseSaltHex, saltPath } from '../../src/report/salt.js';
import { tmpDir } from '../helpers/synth.js';

describe('share salt', () => {
  it('lives under $XDG_CONFIG_HOME, else ~/.config', () => {
    expect(saltPath({ XDG_CONFIG_HOME: '/x/cfg' }, '/home/u')).toBe(path.join('/x/cfg', 'read-receipts', 'salt'));
    expect(saltPath({}, '/home/u')).toBe(path.join('/home/u', '.config', 'read-receipts', 'salt'));
    expect(saltPath({ XDG_CONFIG_HOME: 'relative' }, '/home/u')).toBe(path.join('/home/u', '.config', 'read-receipts', 'salt'));
  });

  it('is created on first use with mode 0600 and stays the same afterwards', async () => {
    const file = path.join(await tmpDir('rr-salt-'), 'cfg', 'read-receipts', 'salt');
    const { salt: a, warning } = await loadOrCreateSalt(file);
    expect(warning).toBeNull();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await loadOrCreateSalt(file)).toEqual({ salt: a, warning: null });
    expect((await readFile(file, 'utf8')).trim()).toBe(a);
  });

  it('two machines get different salts', async () => {
    const a = await loadOrCreateSalt(path.join(await tmpDir('rr-salt-'), 'salt'));
    const b = await loadOrCreateSalt(path.join(await tmpDir('rr-salt-'), 'salt'));
    expect(a.salt).not.toBe(b.salt);
  });

  it('refuses a damaged salt file instead of silently replacing it', async () => {
    const dir = await tmpDir('rr-salt-');
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, 'salt');
    await writeFile(file, 'not hex\n', { mode: 0o600 });
    await expect(loadOrCreateSalt(file)).rejects.toThrow(/salt/);
  });

  it('parses a --share-salt override', () => {
    expect(parseSaltHex('AABBccdd00112233'.repeat(2))).toBe('aabbccdd00112233'.repeat(2));
    for (const bad of ['', 'abc', 'zz'.repeat(16), 'ab'.repeat(4)]) expect(() => parseSaltHex(bad)).toThrow(/share-salt/);
  });

  it.skipIf(process.platform === 'win32')('a group- or world-readable salt is replaced with a warning (F13)', async () => {
    const file = path.join(await tmpDir('rr-salt-'), 'salt');
    const planted = '00'.repeat(32);
    await writeFile(file, `${planted}\n`, { mode: 0o644 });
    await chmod(file, 0o644);
    const { salt, warning } = await loadOrCreateSalt(file);
    expect(salt).not.toBe(planted);
    expect(salt).toMatch(/^[0-9a-f]{64}$/);
    expect(warning).toMatch(/readable by other users.*new salt/);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await readFile(file, 'utf8')).trim()).toBe(salt);
  });
  it.skipIf(process.platform === 'win32')('a salt path that is a symlink is replaced, and its target is left alone (F13)', async () => {
    const dir = await tmpDir('rr-salt-');
    const target = path.join(dir, 'elsewhere');
    await writeFile(target, `${'11'.repeat(32)}\n`, { mode: 0o600 });
    const file = path.join(dir, 'salt');
    await symlink(target, file);
    const { salt, warning } = await loadOrCreateSalt(file);
    expect(salt).not.toBe('11'.repeat(32));
    expect(warning).toMatch(/not a regular file/);
    expect((await readFile(target, 'utf8')).trim()).toBe('11'.repeat(32));
    expect((await stat(file)).isFile()).toBe(true);
  });
});
