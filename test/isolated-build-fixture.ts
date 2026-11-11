/** Build tests must never replace a shared checkout's deployed dist or tracked assets. */
import { cpSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

export function createIsolatedBuild() {
  const source = resolve(import.meta.dirname, '..');
  const root = mkdtempSync(join(tmpdir(), 'codeman-build-test-'));
  try {
    for (const path of [
      'src',
      'scripts',
      'config',
      'package.json',
      'package-lock.json',
      'tsconfig.json',
      'packages/xterm-zerolag-input',
      'packages/gesture-control',
    ]) {
      cpSync(join(source, path), join(root, path), { recursive: true });
    }
    symlinkSync(join(source, 'node_modules'), join(root, 'node_modules'), 'dir');
    return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
