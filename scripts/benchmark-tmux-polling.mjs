#!/usr/bin/env node
// Read-only Linux benchmark against existing panes. No prompts, capture text or native IDs are printed.
import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

if (process.platform !== 'linux') throw new Error('Reaped-helper CPU measurement requires Linux /proc');
const modulePath = resolve(process.argv[2] ?? 'dist/tmux-manager.js');
// Prevent manager initialization from loading/saving production state; injected read executor only.
process.env.VITEST = 'benchmark-read-only';
const { TmuxManager } = await import(pathToFileURL(modulePath).href);
const { resolveTmuxSocketName } = await import(pathToFileURL(resolve(modulePath, '../config/instance.js')).href);
const socket = resolveTmuxSocketName();
assert(/^[\w-]+$/.test(socket));
const file = promisify(execFile), shell = promisify(exec);
const hz = Number((await file('getconf', ['CLK_TCK'])).stdout.trim());
const names = [...new Set((await file('tmux', ['-L', socket, 'list-panes', '-a', '-F', '#{session_name}'])).stdout.trim().split('\n'))]
  .filter(name => /^codeman-[a-f0-9-]+$/.test(name)).slice(0, 16);
assert.equal(names.length, 16, 'Benchmark requires at least 16 existing managed panes');
let commands = 0;
const options = { encoding: 'utf8', timeout: 5000, maxBuffer: 256 * 1024 };
const execute = async (command, args, opts) => { commands++; return file(command, args, opts); };
const mux = new TmuxManager({ paneTextExecutor: execute });
const children = () => {
  const stat = readFileSync('/proc/self/stat', 'utf8').split(') ').at(-1).split(' ');
  return (Number(stat[13]) + Number(stat[14])) / hz * 1000;
};
async function measure(mode, captures) {
  commands = 0;
  const before = process.cpuUsage(), helper = children(), start = performance.now();
  if (mode === 'before') {
    await Promise.all(names.flatMap(name => [
      (async () => { commands++; await shell(`tmux -L '${socket}' display-message -t '${name}' -p '#{pane_dead}'`, options); })(),
      (async () => { commands++; await shell(`tmux -L '${socket}' list-panes -t '${name}' -F '#{pane_id}:#{pane_index}:#{pane_pid}:#{pane_width}:#{pane_height}'`, options); })(),
      ...(captures ? [execute('tmux', ['-L', socket, 'capture-pane', '-p', '-t', name], options),
      execute('tmux', ['-L', socket, 'capture-pane', '-p', '-t', name], options)] : []),
    ]));
  } else {
    const answers = await Promise.all(names.flatMap(name => [
      mux.isPaneDead(name), mux.listPanes(name),
      ...(captures ? [mux.capturePaneTextAsync(name), mux.capturePaneTextAsync(name)] : []),
    ]));
    for (let index = 0; index < answers.length; index += captures ? 4 : 2) {
      assert(answers[index + 1].length > 0, 'Missing pane inventory');
      if (captures) assert(answers[index + 2] !== null && answers[index + 3] !== null, 'Failed frame capture');
    }
  }
  const cpu = process.cpuUsage(before);
  return { mode, workload: captures ? 'inventory-plus-duplicate-frames' : 'inventory-only', tmuxCommands: commands, wallMs: +(performance.now()-start).toFixed(2),
    nodeCpuMs: +((cpu.user+cpu.system)/1000).toFixed(2), reapedHelperCpuMs: +(children()-helper).toFixed(2) };
}
const samples = [];
for (let round = 0; round < 3; round++) {
  // Alternating order reduces directional warmup/host-load bias.
  for (const captures of [false, true]) {
    for (const mode of round % 2 ? ['after', 'before'] : ['before', 'after']) samples.push(await measure(mode, captures));
  }
}
console.log(JSON.stringify({ sessions: names.length, workload: 'same-turn status, geometry, duplicate plain frame',
  warning: 'Read-only live workload microbenchmark; not whole-service CPU or evidence of duplicate-capture frequency in production', samples }));
