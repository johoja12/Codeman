/** Bounded historical-input eligibility. Discovery never authorizes native input. */
import type { GatewayMessage } from './discord-bridge.js';
export const MISSED_INPUT_LOOKBACK_MS = 24 * 60 * 60 * 1000;
export const MISSED_INPUT_SETTLE_MS = 60000;
export function missedInputTime(id: string): number | undefined {
  if (!/^\d{15,20}$/.test(id)) return undefined;
  const value = BigInt(id);
  if (value > (1n << 64n) - 1n) return undefined;
  return Number(value >> 22n) + 1420070400000;
}
export function eligibleMissedInput(
  m: GatewayMessage,
  scope: { channel: string; guild: string; allowed: string[]; now: number }
): boolean {
  const time = missedInputTime(m.id);
  return (
    time !== undefined &&
    scope.now - time >= MISSED_INPUT_SETTLE_MS &&
    scope.now - time <= MISSED_INPUT_LOOKBACK_MS &&
    m.channel_id === scope.channel &&
    (!m.guild_id || m.guild_id === scope.guild) &&
    !!m.author?.id &&
    !m.author.bot &&
    !m.webhook_id &&
    scope.allowed.includes(m.author.id) &&
    (m.type === undefined || m.type === 0 || m.type === 19) &&
    typeof m.content === 'string' &&
    !!m.content.trim() &&
    m.content.length <= 4000 &&
    // eslint-disable-next-line no-control-regex
    !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(m.content) &&
    !/^!codeman(?:\s|$)/i.test(m.content.trimStart()) &&
    !m.attachments?.length
  );
}
