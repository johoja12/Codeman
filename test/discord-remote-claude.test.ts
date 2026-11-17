import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, it, expect } from 'vitest';
import { remoteClaudeRuntimeProbe } from '../src/discord-remote-claude.js';
const exec = promisify(execFile);
const id = '07be20d6-c98c-428d-9d40-17d8c935f6bd';
async function probe(rows: string, env = { HOME: '/home/guest' }, changed = false) {
  const REMOTE_CLAUDE_RUNTIME_PROBE = remoteClaudeRuntimeProbe();
  const at = REMOTE_CLAUDE_RUNTIME_PROBE.indexOf('import hashlib');
  const stub = `\ndef runtime_environment(pid):return ${JSON.stringify(env)}\n`;
  const script =
    `import subprocess\nn=0\ndef output(cmd,**kw):\n global n\n if cmd[0]=='tmux':return '100'\n if '-axo' in cmd:return ${JSON.stringify(rows)}\n n+=1\n return 'stamp'+str(n if ${changed ? 'True' : 'False'} else 1)\nsubprocess.check_output=output\n` +
    REMOTE_CLAUDE_RUNTIME_PROBE.slice(0, at) +
    stub +
    REMOTE_CLAUDE_RUNTIME_PROBE.slice(at);
  const result = await exec('python3', [
    '-c',
    script,
    JSON.stringify({ location: { socket: 'fixture', sessionName: 'fixture' } }),
  ]);
  return JSON.parse(result.stdout);
}
describe('remote Claude profile identity', () => {
  it('reads only the attached native process and its own home', async () => {
    const r = await probe(
      `100 1 /bin/bash\n101 100 claude --dangerously-skip-permissions --resume ${id}\n200 1 claude --resume aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`
    );
    expect(r).toMatchObject({ id, configHome: '/home/guest/.claude' });
    expect(r.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
  it('uses an explicit runtime config home', async () => {
    expect(
      await probe(`100 1 claude --session-id=${id}`, { HOME: '/home/guest', CLAUDE_CONFIG_DIR: '/srv/account' } as {
        HOME: string;
      })
    ).toMatchObject({ id, configHome: '/srv/account' });
  });
  it.each([
    `100 1 sh -c 'claude --resume ${id}'`,
    `100 1 sh\n101 100 claude --resume ${id}\n102 100 claude --resume ${id}`,
    `100 1 claude -p 'do work' --resume ${id}`,
    `100 1 claude --model --resume ${id}`,
    '100 1 claude --resume --last',
    `100 1 claude --resume ${id} --session-id ${id}`,
  ])('refuses an ambiguous or noninteractive invocation: %s', async (rows) => {
    await expect(probe(rows)).rejects.toThrow();
  });
  it.each([
    `100 1 claude --resume ${id}\n101 100 claude -p 'child job'`,
    `100 1 claude --resume ${id}\n101 100 sh\n102 101 claude --resume aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`,
    `100 1 sh\n101 100 claude --resume ${id}\n102 101 claude -p 'child job'`,
  ])('keeps the controlling Claude identity while nested CLI jobs run: %s', async (rows) => {
    expect(await probe(rows)).toMatchObject({ id, configHome: '/home/guest/.claude' });
  });
  it('does not promote a nested interactive process under an unsupported controller', async () => {
    await expect(probe(`100 1 claude -p 'parent job'\n101 100 claude --resume ${id}`)).rejects.toThrow();
  });
  it('rejects a process changing during the environment read', async () => {
    await expect(probe(`100 1 claude --resume ${id}`, undefined, true)).rejects.toThrow();
  });
});
