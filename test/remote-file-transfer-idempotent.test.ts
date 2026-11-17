/** Real shell regressions for GNU mv no-clobber skip codes; no SSH or production paths. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { buildRemoteFileWriteScript } from '../src/remote-file-transfer.js';
const exec = promisify(execFile),
  dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function fixture(skip: number, allow = true) {
  const root = await mkdtemp(join(tmpdir(), 'codeman-idempotent-'));
  dirs.push(root);
  const dir = join(root, 'uploads'),
    file = join(dir, '.gitignore'),
    tmp = join(dir, 'staged.tmp');
  const script = buildRemoteFileWriteScript({
    dir,
    filePath: file,
    tmpPath: tmp,
    notADirectoryMessage: 'Unsafe upload directory',
    privateDirectory: true,
    strict: true,
    allowIdenticalExisting: allow,
  });
  // Exercise both old and new mv implementations without depending on the test host's version.
  const prefix = `mv() { if [ -e "$3" ] || [ -L "$3" ]; then return ${skip}; fi; command mv "$@"; }\n`;
  const write = async (text: string, extraPrefix = prefix) => {
    const input = join(root, 'input');
    await writeFile(input, text);
    return exec('sh', ['-c', extraPrefix + 'exec 0<"$1"\n' + script, 'sh', input]);
  };
  return { root, dir, file, tmp, write };
}
it.each([0, 1])('accepts repeated identical metadata with mv skip status %i', async (skip) => {
  const f = await fixture(skip);
  await f.write('*\n');
  await f.write('*\n');
  expect(await readFile(f.file, 'utf8')).toBe('*\n');
  expect(await readdir(f.dir)).toEqual(['.gitignore']);
});
it.each([0, 1])('rejects different existing bytes without overwriting them with mv skip status %i', async (skip) => {
  const f = await fixture(skip);
  await f.write('*\n');
  await expect(f.write('different\n')).rejects.toThrow();
  expect(await readFile(f.file, 'utf8')).toBe('*\n');
  expect(await readdir(f.dir)).toEqual(['.gitignore']);
});
it.each(['symlink', 'directory'])('rejects an existing %s metadata destination and cleans staging', async (kind) => {
  const f = await fixture(1);
  await mkdir(f.dir);
  const outside = join(f.root, 'outside');
  await writeFile(outside, '*\n');
  if (kind === 'symlink') await symlink(outside, f.file);
  else await mkdir(f.file);
  await expect(f.write('*\n')).rejects.toThrow();
  expect(await readFile(outside, 'utf8')).toBe('*\n');
  expect(await readdir(f.dir)).toEqual(['.gitignore']);
});
it('does not mask a genuine publication failure when no destination exists', async () => {
  const f = await fixture(1);
  await expect(f.write('*\n', 'mv() { return 1; }\n')).rejects.toThrow();
  expect(await readdir(f.dir)).toEqual([]);
});
it('keeps the default strict no-clobber collision behavior for ordinary uploads', async () => {
  const f = await fixture(1, false);
  await f.write('original');
  await expect(f.write('replacement')).rejects.toThrow();
  expect(await readFile(f.file, 'utf8')).toBe('original');
  expect(await readdir(f.dir)).toEqual(['.gitignore']);
});
