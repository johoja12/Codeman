import { normalizeCapturedFrame } from './approval-inbox.js';

/** Conservative visible-pane fallback for Claude's checkbox AskUserQuestion UI.
 * Never infer a dialog from transcript prose or enable single-digit answers for multi-select.
 */
export function claudeVisibleQuestion(raw: string): string | undefined {
  const frame = normalizeCapturedFrame(raw);
  if (!frame) return undefined;
  const lines = frame.split('\n');
  const footer = lines.findIndex((line) =>
    /^\s*Enter to select\s*·\s*↑\/↓ to navigate\s*·\s*Esc to cancel\s*$/.test(line)
  );
  if (footer < 0 || lines.slice(footer + 1).some((line) => line.trim())) return undefined;
  const options = [...frame.matchAll(/^\s*[❯>]?\s*(\d+)\.\s+\[[ xX✓✔]\]\s+(.+)$/gm)];
  if (options.length < 2 || options.length > 6 || options.some((m, i) => Number(m[1]) !== i + 1)) return undefined;
  const first = options[0].index!;
  const prefix = frame.slice(0, first);
  const question = prefix
    .split('\n')
    .filter((line) => /^\s*│/.test(line))
    .map((line) => line.replace(/^\s*│\s?/, '').trim())
    .join(' ');
  if (!question || !/^\s*Submit\s*$/m.test(frame.slice(first))) return undefined;
  return `${question}\n\n${options.map((m) => `${m[1]}. ${m[2].trim()}`).join('\n')}\n\nSelect one or more options and submit in the terminal.`;
}

/** A positive idle-composer observation can clear our own fallback, never a failed/partial read. */
export function claudeQuestionGone(raw: string): boolean {
  const frame = normalizeCapturedFrame(raw);
  return !!frame && !frame.includes('Enter to select') && /(?:^|\n)\s*❯\s*[^\n]*\n[─━]{3,}/.test(frame);
}
