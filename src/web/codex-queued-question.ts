/** Read-only Codex queue chrome. Undefined means an incomplete/unrecognized frame, not resolution. */
import { stripAnsi } from '../utils/regex-patterns.js';
export function codexQueuedQuestionCount(frame: string): number | undefined {
  if (!frame || Buffer.byteLength(frame) > 128 * 1024) return undefined;
  const rows = stripAnsi(frame)
    .split('\n')
    .map((row) => row.trimEnd())
    .filter((row) => row.trim());
  let composer = -1;
  for (let i = rows.length - 1; i >= 0; i--)
    if (/^\s*›(?:\s|$)/.test(rows[i])) {
      composer = i;
      break;
    }
  if (composer < 0 || composer < rows.length - 6) return undefined;
  const footer = rows.slice(composer + 1);
  if (
    !footer.length ||
    !footer.some((row) => /\? for shortcuts|← for agents/.test(row)) ||
    footer.some((row) => !/^\s+(?:.* · .*|.*\? for shortcuts.*|.*← for agents.*)$/.test(row))
  )
    return undefined;
  // Only the block directly above the real composer counts. A quoted block followed by
  // normal transcript/working chrome cannot turn into a queued-question alert.
  const block = rows.slice(Math.max(0, composer - 8), composer).map((row) => row.trim());
  const heading = block.lastIndexOf('• Queued follow-up inputs');
  if (heading < 0) return 0;
  const queue = block.slice(heading + 1);
  if (!queue.some((row) => /^\? \d+ questions?$/.test(row) || /^[Ss]hift\+← to answer$/.test(row))) return 0;
  if (queue.some((row) => /^Working \(.*esc to interrupt/.test(row))) return 0;
  if (queue.length !== 2 || !/^[Ss]hift\+← to answer$/.test(queue[1])) return undefined;
  const count = /^\? ([1-9]\d{0,2}) (question|questions)$/.exec(queue[0]);
  if (!count || (Number(count[1]) === 1) !== (count[2] === 'question')) return undefined;
  return Number(count[1]);
}
