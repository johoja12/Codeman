#!/usr/bin/env node
/** Synthetic Claude parsing benchmark; no live transcripts, network or native input. Build first.
 * node scripts/benchmark-discord-history.mjs [path-to-discord-history.js]
 */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const moduleUrl = process.argv[2]
  ? pathToFileURL(resolve(process.argv[2]))
  : new URL('../dist/discord-history.js', import.meta.url);
const { parseDiscordHistory } = await import(moduleUrl.href);
const conversationId = '12345678-1234-1234-1234-123456789abc';
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const results = [];
for (const count of [64, 512, 1536]) {
  const rows =
    Array.from({ length: count }, (_, i) =>
      JSON.stringify({
        type: 'assistant',
        sessionId: conversationId,
        timestamp: '2026-11-25T00:00:00Z',
        message: {
          model: 'claude-opus-5-5',
          content: `${i}: ${'synthetic benchmark text '.repeat(16)}`,
          stop_reason: 'end_turn',
        },
      })
    ).join('\n') + '\n';
  const packet = JSON.stringify({ offset: 0, data: Buffer.from(rows).toString('base64'), partial: false });
  const source = { mode: 'claude', conversationId };
  parseDiscordHistory(source, packet);
  const wall = [],
    cpu = [];
  for (let run = 0; run < 5; run++) {
    const started = performance.now(),
      before = process.cpuUsage();
    const history = parseDiscordHistory(source, packet);
    const used = process.cpuUsage(before);
    wall.push(performance.now() - started);
    cpu.push((used.user + used.system) / 1000);
    assert.equal(history.turns.length, count);
    assert.equal(history.reportedSettings.model, 'claude-opus-5-5');
  }
  results.push({
    rows: count,
    packetBytes: Buffer.byteLength(packet),
    medianWallMs: +median(wall).toFixed(3),
    medianCpuMs: +median(cpu).toFixed(3),
    runs: 5,
  });
}
console.log(JSON.stringify({ benchmark: 'synthetic Claude history parsing', results }, null, 2));
