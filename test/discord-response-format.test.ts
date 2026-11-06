/** @fileoverview Response presentation preserves code/content while adding native Discord hierarchy. */
import { describe, expect, it } from 'vitest';
import { discordResponsePosts, formatDiscordResponseText } from '../src/discord-response-format.js';
describe('readable Discord responses', () => {
  it('separates and emphasizes short numbered labels without rewriting prose', () => {
    const body =
      'The revised flow needs:\n1. Spread: show separate GPUs.\n2. Transition to Shared.\n3. Shared: show all three workloads.\n4. Compare: matched five-minute windows.';
    expect(formatDiscordResponseText(body)).toBe(
      'The revised flow needs:\n\n1. **Spread:** show separate GPUs.\n\n2. Transition to Shared.\n\n3. **Shared:** show all three workloads.\n\n4. **Compare:** matched five-minute windows.'
    );
  });
  it('styles obvious file paths while preserving URLs, Markdown links and inline code', () => {
    const body =
      'Saved (output/demo-revision-20261106/STORYBOARD.md).\n[Open](https://example.test/demo.md) https://example.test/demo.md\n`output/literal.md` and /tmp/already.py';
    const formatted = formatDiscordResponseText(body);
    expect(formatted).toContain('(`output/demo-revision-20261106/STORYBOARD.md`)');
    expect(formatted).toContain('[Open](https://example.test/demo.md) https://example.test/demo.md');
    expect(formatted).toContain('`output/literal.md` and /tmp/already.py');
    expect(formatDiscordResponseText(formatted)).toBe(formatted);
  });
  it.each(['```', '````', '~~~'])('preserves literal code inside %s fences, indentation and blockquotes', (fence) => {
    const code = `${fence}text\n1. Literal: /tmp/file.py  \n| a | b |\n|---|---|\n| x | y |\n${fence}\n    1. Literal: /tmp/file.py\n> 1. Quote: /tmp/file.py`;
    expect(formatDiscordResponseText(code)).toBe(code);
  });
  it('preserves existing emphasis and nested lists rather than promoting them to headings', () => {
    const body = '1. **Spread:** details\n   - nested bullet\n   - next bullet\n\n2. **Shared:** details';
    expect(formatDiscordResponseText(body)).toBe(body);
  });
  it('uses chat-width text and suppresses URL previews rather than narrow embeds', () => {
    const posts = discordResponsePosts('1. Spread: details\n2. Shared: details\n\nhttps://example.test/demo');
    expect(posts).toHaveLength(1);
    expect(posts[0].content).toBe(
      '**Response**\n\n1. **Spread:** details\n\n2. **Shared:** details\n\nhttps://example.test/demo'
    );
    expect(posts[0].embeds).toBeUndefined();
    expect(posts[0].flags).toBe(4);
    expect(posts[0].allowed_mentions).toEqual({ parse: [], users: [] });
  });
  it('keeps long responses within message limits, numbers continuations and pings only the first part', () => {
    const text = Array.from({ length: 80 }, (_, i) => `Paragraph ${i}: ` + 'detail '.repeat(15)).join('\n\n');
    const posts = discordResponsePosts(text, { users: ['333333333333333333'] });
    expect(posts.length).toBeGreaterThan(1);
    expect(posts.length).toBeLessThanOrEqual(8);
    expect(posts.every((p) => p.content.length <= 2000)).toBe(true);
    expect(posts[0].content).toContain('<@333333333333333333>');
    expect(posts[0].content).toContain(`1 / ${posts.length}`);
    expect(
      posts
        .slice(1)
        .every(
          (p) =>
            !p.content.includes('<@333333333333333333>') &&
            p.allowed_mentions.users.length === 0 &&
            !p.content.includes('**Response**')
        )
    ).toBe(true);
    const visible = posts.map((p) => p.content).join('\n');
    for (let i = 0; i < 80; i++) expect(visible).toContain(`Paragraph ${i}:`);
  });
  it.each(['```', '````', '~~~'])('closes and reopens long %s code blocks without altering their rows', (fence) => {
    const lines = Array.from({ length: 400 }, (_, i) => `const row${i} = ${i};`);
    const posts = discordResponsePosts(`${fence}js\n${lines.join('\n')}\n${fence}`);
    expect(posts.length).toBeGreaterThan(1);
    for (const post of posts) {
      expect(post.content.includes(fence + 'js\n')).toBe(true);
      expect(post.content.slice(0, post.content.lastIndexOf('\n-#')).endsWith(fence)).toBe(true);
    }
    const combined = posts.map((p) => p.content).join('\n');
    for (const line of lines) expect(combined.split(line)).toHaveLength(2);
  });
  it('makes truncation explicit and does not turn output mentions into notification permissions', () => {
    const posts = discordResponsePosts('@everyone ' + 'x'.repeat(100000));
    expect(posts).toHaveLength(8);
    expect(posts.at(-1)!.content).toContain('The message continues in the tab.');
    expect(posts.every((p) => p.allowed_mentions.parse.length === 0 && p.allowed_mentions.users.length === 0)).toBe(
      true
    );
  });
  it('leaves unusually large lines untouched by prose heuristics', () => {
    const text = 'a/'.repeat(100000) + 'file.md';
    expect(formatDiscordResponseText(text)).toBe(text);
  });
});
it('keeps multiline inline-code content literal', () => {
  const text = 'An inline span: `start\n1. Literal: output/example.md\nend`\n\n1. Label: normal prose';
  expect(formatDiscordResponseText(text)).toBe(
    'An inline span: `start\n1. Literal: output/example.md\nend`\n\n1. **Label:** normal prose'
  );
});
it('bounds prose-formatting CPU on steerable punctuation and long path-like input', () => {
  const text = Array(80).fill('['.repeat(8190)).join('\n') + '\n' + 'a/'.repeat(100000);
  const before = process.cpuUsage();
  expect(formatDiscordResponseText(text)).toBe(text);
  const used = process.cpuUsage(before);
  expect((used.user + used.system) / 1000).toBeLessThan(300);
});
