import { normalizeCapturedFrame } from './approval-inbox.js';

/** Conservative visible-pane fallback for Claude's single-choice and checkbox AskUserQuestion UI.
 * Never infer a dialog from transcript prose or enable single-digit answers for multi-select.
 */
export interface ClaudeVisibleQuestion {
  text: string;
  question: string;
  identity: string;
  multiSelect: boolean;
  selected: number;
  choices: Array<{ n: number; label: string }>;
}
export function parseClaudeVisibleQuestion(raw: string): ClaudeVisibleQuestion | undefined {
  const frame = normalizeCapturedFrame(raw, { maxLines: 160, maxChars: 24000 });
  if (!frame) return undefined;
  const lines = frame.split('\n');
  const footer = lines.findIndex((line) =>
    /^\s*Enter to select\s*·\s*↑\/↓ to navigate\s*·\s*Esc to cancel\s*$/.test(line)
  );
  if (footer < 0 || lines.slice(footer + 1).some((line) => line.trim())) return undefined;
  const options = [...frame.matchAll(/^\s*[❯>]?\s*(\d+)\.\s+(?:(\[[ xX✓✔]\])\s+)?(.+)$/gm)];
  if (options.length < 3 || options.length > 7 || options.some((m, i) => Number(m[1]) !== i + 1)) return undefined;
  if (!/^Chat about this\s*$/.test(options.at(-1)![3])) return undefined;
  const choices = options.slice(0, -1);
  const checkbox = choices.every((m) => m[2] !== undefined);
  if (!checkbox && choices.some((m) => m[2] !== undefined)) return undefined;
  if (!/^Type something\.?$/.test(choices.at(-1)![3].trim())) return undefined;
  if (!choices.some((m) => /^\s*❯/.test(m[0]))) return undefined;
  if (checkbox && !/^\s*Submit\s*$/m.test(frame.slice(choices[0].index!))) return undefined;
  const before = frame.slice(0, choices[0].index!).trimEnd().split('\n');
  const prefix = [...before];
  const question: string[] = [];
  for (const line of prefix.reverse()) {
    if (!/^\s*│/.test(line)) break;
    question.unshift(line.replace(/^\s*│\s?/, '').trim());
  }
  if (!question.length) {
    // Recent Claude builds render the question without a left border, beneath its tab heading.
    const header = before.map((line) => /^\s*☐\s+\S/.test(line)).lastIndexOf(true);
    if (header < 0 || before.length - header > 24) return undefined;
    question.push(
      ...before
        .slice(header + 1)
        .map((line) => line.trim())
        .filter(Boolean)
    );
  }
  if (!question.length) return undefined;
  const labels = checkbox ? choices : options;
  const text = `${question.join(' ')}\n\n${labels.map((m) => `${m[1]}. ${m[3].trim()}`).join('\n')}\n\n${checkbox ? 'Select one or more options and submit' : 'Choose an option'} in the terminal.`;
  return {
    text,
    question: question.join(' '),
    multiSelect: checkbox,
    selected: Number(choices.find((m) => /^\s*❯/.test(m[0]))![1]),
    choices: choices.slice(0, -1).map((m) => ({ n: Number(m[1]), label: m[3].trim() })),
    identity: JSON.stringify([
      question.join(' '),
      options.map((m, i) =>
        frame
          .slice(m.index!, options[i + 1]?.index ?? footerOffset(frame))
          .replace(/^\s*[❯>]?\s*(\d+)\.\s+/, '$1. ')
          .replace(/\s+/g, ' ')
          .trim()
      ),
    ]),
  };
}

const footerOffset = (frame: string) => frame.lastIndexOf('Enter to select');
export function claudeVisibleQuestion(raw: string): string | undefined {
  return parseClaudeVisibleQuestion(raw)?.text;
}

/** A positive idle-composer observation can clear our own fallback, never a failed/partial read. */
export function claudeQuestionGone(raw: string): boolean {
  const frame = normalizeCapturedFrame(raw, { maxLines: 160, maxChars: 24000 });
  return !!frame && !frame.includes('Enter to select') && /(?:^|\n)\s*❯\s*[^\n]*\n[─━]{3,}/.test(frame);
}

/** Hook tool checks have a different footer/choice contract from AskUserQuestion.
 * Detection is alert-only: no digits or approval keys are inferred from this pane.
 */
export function parseClaudeHookConfirmation(raw: string): { text: string; toolName: string } | undefined {
  // Most polls are ordinary output; avoid another full normalization pass.
  if (!raw.includes('Hook') || !raw.includes('confirmation')) return undefined;
  const frame = normalizeCapturedFrame(raw, { maxLines: 160, maxChars: 24000 });
  if (!frame) return undefined;
  // Permit indentation, but require a complete menu at the bottom of the live pane.
  const menu =
    /^\s*Do you want to proceed\?\s*\n\s*([❯>]?)\s*1\. Yes\s*\n\s*([❯>]?)\s*2\. No\s*\n\s*Esc to cancel · Tab to amend\s*$/m.exec(
      frame
    );
  if (!menu || frame.slice(menu.index + menu[0].length).trim() || Number(!!menu[1]) + Number(!!menu[2]) !== 1)
    return undefined;
  const before = frame.slice(0, menu.index);
  const heading = [...before.matchAll(/^\s*Bash command\s*$/gm)].at(-1);
  if (!heading) return undefined;
  const body = before.slice(heading.index!);
  const hook = /^\s*(?:│\s*)?Hook ([\w.-]{1,80}) requires confirmation for this command:\s*$/m.exec(body);
  if (!hook) return undefined;
  return {
    toolName: hook[1],
    text: body.trim() + '\n\nPermission required. Review and choose Yes or No in the terminal.',
  };
}
