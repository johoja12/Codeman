/** Fake procfs only: no real panes, model processes, credentials or terminal input. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { REMOTE_CODEX_RUNTIME_PROBE, REMOTE_CODEX_RESUME_PROBE } from '../src/discord-remote-conversation.js';
const exec = promisify(execFile);
const id = '01a197ca-f81d-7cf1-82b0-7dbdd241eb22';
interface Proc {
  pid: number;
  parent: number;
  argv: string[];
  threads?: Record<string, number[]>;
  start?: string;
}
const basic = (): Proc[] => [
  { pid: 100, parent: 1, argv: ['/bin/sh'], threads: { '100': [101] } },
  { pid: 101, parent: 100, argv: ['/opt/codex', 'resume', id] },
];
const stat = (p: Proc) =>
  `${p.pid} (name with ) parentheses) ${['S', String(p.parent), ...Array(17).fill('0'), p.start ?? '123'].join(' ')}`;
async function probe(
  nodes = basic(),
  options: {
    runtime?: boolean;
    env?: string;
    deny?: string;
    malformed?: string;
    change?: 'pid' | 'argv' | 'root';
    threadLimit?: boolean;
    oversized?: boolean;
  } = {}
) {
  const dir = await mkdtemp(join(tmpdir(), 'codeman-proc-'));
  try {
    for (const p of nodes) {
      const base = join(dir, String(p.pid));
      await mkdir(join(base, 'task'), { recursive: true });
      await writeFile(join(base, 'stat'), options.malformed === String(p.pid) ? 'malformed' : stat(p));
      await writeFile(
        join(base, 'cmdline'),
        options.oversized && p.pid === 101 ? 'x'.repeat(4 * 1024 * 1024 + 1) : p.argv.join('\0') + '\0'
      );
      await writeFile(
        join(base, 'environ'),
        options.env ?? 'HOME=/home/test\0CODEX_HOME=/profile with spaces\0API_KEY=SECRET\0'
      );
      await symlink('/work', join(base, 'cwd'));
      for (const [tid, children] of Object.entries(p.threads ?? { [p.pid]: [] })) {
        await mkdir(join(base, 'task', tid));
        await writeFile(join(base, 'task', tid, 'children'), children.join(' '));
      }
    }
    const prelude = `import subprocess,builtins,os,sys
sys.platform='linux'
fixture_root=${JSON.stringify(dir)}
real_open=builtins.open;real_list=os.listdir;real_link=os.readlink
def mapped(p):
 return fixture_root+p[5:] if isinstance(p,str) and p.startswith('/proc/') else p
def opened(p,*args,**kwargs):
 if p==${JSON.stringify(options.deny ?? '')}:raise PermissionError('fixture denied')
 if isinstance(p,str) and p.startswith('/proc/999/'):raise Exception('unrelated process inspected')
 handle=real_open(mapped(p),*args,**kwargs)
 if p=='/proc/101/cmdline' and ${options.change === 'root' ? 'True' : 'False'}:
  with real_open(fixture_root+'/100/stat','w') as f:f.write(${JSON.stringify(stat({ pid: 100, parent: 1, argv: [], start: '999' }))})
 if p=='/proc/101/environ':
  if ${options.change === 'pid' ? 'True' : 'False'}:
   with real_open(fixture_root+'/101/stat','w') as f:f.write(${JSON.stringify(stat({ pid: 101, parent: 100, argv: [], start: '999' }))})
  if ${options.change === 'argv' ? 'True' : 'False'}:
   with real_open(fixture_root+'/101/cmdline','wb') as f:f.write(b'/opt/codex\\0resume\\0aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa\\0')
 return handle
builtins.open=opened
os.listdir=lambda p: [str(i) for i in range(4097)] if ${options.threadLimit ? 'True' : 'False'} and p=='/proc/100/task' else real_list(mapped(p))
os.readlink=lambda p:real_link(mapped(p))
def command(cmd,**kwargs):
 if cmd[0]=='tmux':return '100'
 raise Exception('unexpected subprocess: Linux must not launch ps')
subprocess.check_output=command
`;
    const result = await exec(
      'python3',
      [
        '-c',
        prelude + (options.runtime ? REMOTE_CODEX_RUNTIME_PROBE : REMOTE_CODEX_RESUME_PROBE),
        JSON.stringify({ location: { socket: 'fixture', sessionName: 'fixture' } }),
      ],
      { timeout: 15000 }
    );
    return JSON.parse(result.stdout);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
it('reads the exact Linux native profile without ps or unrelated process inspection', async () => {
  const nodes = basic();
  nodes.push({ pid: 999, parent: 1, argv: ['codex', 'resume', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'] });
  const result = await probe(nodes, { runtime: true });
  expect(result).toMatchObject({
    id,
    configHome: '/profile with spaces',
    fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(JSON.stringify(result)).not.toMatch(/SECRET|API_KEY/);
});
it('includes native children created by non-leader threads and ignores auxiliary CLIs', async () => {
  const nodes = basic();
  nodes[0].threads = { '100': [], '150': [101, 102] };
  nodes.push({ pid: 102, parent: 100, argv: ['codex', 'app-server'] });
  expect((await probe(nodes)).id).toBe(id);
  nodes[2].argv = ['codex', 'resume', id];
  expect((await probe(nodes)).id).toBeNull();
});
it('keeps exact argv boundaries for config values, prompts and resume IDs', async () => {
  const nodes = basic();
  nodes[1].argv = ['codex', '--config', 'value with spaces and resume', 'resume', id];
  expect((await probe(nodes)).id).toBe(id);
  nodes.push({ pid: 102, parent: 100, argv: ['codex', 'write an exec summary'] });
  nodes[0].threads!['100'].push(102);
  expect((await probe(nodes)).id).toBeNull();
});
it.each(['pid', 'argv'] as const)('refuses native %s replacement during environment read', async (change) => {
  await expect(probe(basic(), { runtime: true, change })).rejects.toThrow('process changed');
});
it('refuses inaccessible, malformed and oversized metadata instead of guessing', async () => {
  await expect(probe(basic(), { deny: '/proc/100/task/100/children' })).rejects.toThrow('denied');
  await expect(probe(basic(), { malformed: '101' })).rejects.toThrow('identity');
  await expect(probe(basic(), { oversized: true })).rejects.toThrow('metadata limit');
});
it('refuses a parent mismatch and tolerates a child that has already vanished', async () => {
  const nodes = basic();
  nodes[1].parent = 999;
  await expect(probe(nodes)).rejects.toThrow('process tree changed');
  nodes[1].parent = 100;
  nodes[0].threads!['100'].push(555);
  expect((await probe(nodes)).id).toBe(id);
});
it('fails closed at the process-tree depth and count limits', async () => {
  const chain = Array.from({ length: 18 }, (_, i) => ({
    pid: 100 + i,
    parent: i ? 99 + i : 1,
    argv: ['/bin/sh'],
    threads: { [100 + i]: i < 17 ? [101 + i] : [] },
  }));
  await expect(probe(chain)).rejects.toThrow('depth limit');
  const nodes = basic();
  nodes[0].threads!['100'] = Array.from({ length: 65 }, (_, i) => 101 + i);
  await expect(probe(nodes)).rejects.toThrow('ambiguous process tree');
});
it.each(['HOME=/a\0HOME=/b\0', 'CODEX_HOME=/a\nother\0', 'OTHER=no-home\0'])(
  'retains strict Linux environment validation',
  async (env) => {
    await expect(probe(basic(), { runtime: true, env })).rejects.toThrow();
  }
);

it('refuses pane replacement during traversal and excessive thread inventories', async () => {
  await expect(probe(basic(), { change: 'root' })).rejects.toThrow('pane process changed');
  await expect(probe(basic(), { threadLimit: true })).rejects.toThrow('thread limit');
});
