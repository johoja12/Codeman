/** @fileoverview Classified connection states remain consistent across native cards and thread titles. */
import { expect, it } from 'vitest';
import { classifyRemoteWorkerProbeFailure } from '../src/remote-hosts.js';
import { discordConnectionLabel, discordConnectionDetail } from '../src/discord-connection-status.js';
import { discordActivityName } from '../src/discord-activity.js';
import type { DiscordConnection } from '../src/discord-native-ui-types.js';
it.each([
  ['ssh: connect to host 192.168.20.91 port 22: No route to host', 'unreachable'],
  ['ssh: connect to host worker port 22: Connection refused', 'unreachable'],
  ['ssh: connect to host worker port 22: Connection timed out', 'unreachable'],
  ['ssh: Could not resolve hostname worker: Name or service not known', 'unreachable'],
  ['u@worker: Permission denied (publickey).', 'authentication'],
  ['Too many authentication failures', 'authentication'],
  ['WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!', 'host_key'],
  ['Host key verification failed.', 'host_key'],
  ['Connection closed by remote host', 'probe_failed'],
  ['python3: command not found', 'probe_failed'],
])('classifies SSH failure without exposing raw stderr: %s', (stderr, expected) => {
  expect(classifyRemoteWorkerProbeFailure({ code: 255, stderr })).toBe(expected);
  expect(classifyRemoteWorkerProbeFailure({ code: 1, stderr })).toBe('probe_failed');
});
it.each([
  ['worker_unreachable', '🔴 Worker unreachable'],
  ['ssh_auth_failed', '🔴 SSH authentication failed'],
  ['ssh_host_key', '🔴 SSH trust changed'],
  ['worker_check_failed', '🟠 Worker check failed'],
  ['conversation_unverified', '🟠 Conversation unverified'],
  ['pane_unverified', '🟠 Terminal check failed'],
  ['session_changing', '🟡 Session updating'],
  ['check_failed', '🟠 Status check failed'],
] as const)('uses the same %s label in cards and thread activity', (reason, label) => {
  const connection: DiscordConnection = { state: 'unverified', reason };
  expect(discordConnectionLabel(connection)).toBe(label);
  expect(
    discordActivityName({ id: 's', name: 'w30-buildmesh', connection: connection.state, connectionReason: reason })
  ).toBe(label + ' · w30-buildmesh');
  expect(discordConnectionDetail(connection).length).toBeGreaterThan(25);
});
it('never turns authentication, unknown probe errors or terminal disconnection into an agent exit', () => {
  expect(discordConnectionLabel({ state: 'connection_lost' })).toBe('🔴 Terminal disconnected');
  expect(discordConnectionLabel({ state: 'agent_exited' })).toBe('🔴 Agent exited');
});
