import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  claudeVisibleQuestion,
  claudeQuestionGone,
  parseClaudeHookConfirmation,
  parseClaudeCompactionPrompt,
} from '../src/web/claude-visible-question.js';
import { approvalInbox } from '../src/web/approval-inbox.js';

const frame = `Free disk  ✔ Submit  →

│ Which caches should I clear?
│ These can be regenerated.

❯ 1. [ ] Build target (94G)
         Build output, kept release files.
  2. [x] Docker images (~25G)
         Unused images only.
  3. [ ] Type something
     Submit
────────────────────
  4. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`;
beforeEach(() => {
  approvalInbox.stop();
});
describe('visible Claude multi-select question', () => {
  it('keeps the wrapped question and every label, including the text alternative', () => {
    expect(claudeVisibleQuestion(frame)).toBe(
      'Which caches should I clear? These can be regenerated.\n\n1. Build target (94G)\n2. Docker images (~25G)\n3. Type something\n\nSelect one or more options and submit in the terminal.'
    );
    expect(claudeVisibleQuestion('\x1b[32m' + frame + '\x1b[0m')).toBe(claudeVisibleQuestion(frame));
  });
  it.each([
    '',
    frame.replace('Enter to select', 'Enter to confirm'),
    frame + '❯ normal composer',
    frame.replace('2. [x]', '7. [x]'),
    frame.replace('     Submit\n', ''),
    frame.replaceAll('│', ''),
    '```\n' + frame + '```',
  ])('rejects incomplete dialogs, examples and inconsistent choices', (value) => {
    expect(claudeVisibleQuestion(value)).toBeUndefined();
  });
  it('requires a fresh normal composer to conclude a question disappeared', () => {
    expect(claudeQuestionGone(frame)).toBe(false);
    expect(claudeQuestionGone('Partial capture')).toBe(false);
    expect(claudeQuestionGone('────\n❯ \n────')).toBe(true);
  });
});
