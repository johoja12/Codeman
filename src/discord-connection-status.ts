/** @fileoverview Evidence-based Discord health labels; no raw SSH errors or credentials are displayed. */
import type { DiscordConnection } from './discord-native-ui-types.js';
const reasons: Record<NonNullable<DiscordConnection['reason']>, [string, string]> = {
  worker_unreachable: [
    '🔴 Worker unreachable',
    'Cannot reach the remote worker over SSH. Check its power, network and address. Verification retries automatically.',
  ],
  ssh_auth_failed: [
    '🔴 SSH authentication failed',
    'The worker rejected SSH authentication. Check the configured SSH user and key in Codeman.',
  ],
  ssh_host_key: [
    '🔴 SSH trust changed',
    'The worker’s SSH identity could not be trusted. Verify its host key before reconnecting.',
  ],
  worker_check_failed: [
    '🟠 Worker check failed',
    'The worker probe did not produce a valid result. Its agent state is unknown; verification will retry.',
  ],
  conversation_unverified: [
    '🟠 Conversation unverified',
    'The terminal is reachable, but its exact conversation or profile could not be verified. No input will be sent until verification succeeds.',
  ],
  pane_unverified: [
    '🟠 Terminal check failed',
    'The local terminal could not be inspected. This does not confirm that the agent exited.',
  ],
  session_changing: [
    '🟡 Session updating',
    'The session or its conversation changed during verification. A fresh check will retry.',
  ],
  check_failed: [
    '🟠 Status check failed',
    'A status check failed without enough evidence to identify the cause. Verification will retry.',
  ],
};
export function discordConnectionLabel(connection: DiscordConnection): string {
  if (connection.state === 'available') return 'Connected';
  if (connection.state === 'agent_exited') return '🔴 Agent exited';
  if (connection.state === 'connection_lost') return '🔴 Terminal disconnected';
  return connection.reason ? reasons[connection.reason][0] : '🔴 Connection unverified';
}
export function discordConnectionDetail(connection: DiscordConnection): string {
  if (connection.state === 'agent_exited')
    return 'The native agent is no longer running. Use an offered exact-conversation recovery option, or inspect it in Codeman.';
  if (connection.state === 'connection_lost')
    return 'This terminal attachment is disconnected. Use Reconnect if offered, or inspect the session in Codeman.';
  return connection.reason
    ? reasons[connection.reason][1]
    : 'Open Codeman to inspect the session; its connection is not verified.';
}
