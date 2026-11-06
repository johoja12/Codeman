/** @fileoverview Discord-native response cards and conservative, code-aware prose formatting. */
import type { DiscordPost } from './discord-bridge.js';
import { formatDiscordTables } from './discord-tables.js';

export const DISCORD_RESPONSE_COLOR = 0x58a6ff;
export const DISCORD_WARNING_COLOR = 0xf2b84b;
export const DISCORD_CRITICAL_COLOR = 0xed6b6b;

function splitMarkdown(text: string, max = 1900, maxPosts = 8): string[] {
  if (!Number.isInteger(max) || max < 128 || max > 4096 || !Number.isInteger(maxPosts) || maxPosts < 1 || maxPosts > 64)
    throw new RangeError('Invalid Discord message chunk limits');
  const posts: string[] = [];
  let cur = '';
  let fence: { marker: string; hint: string } | null = null;
  let cut = false;
  const budget = max - 64; // Reserve a closing fence and the explicit overflow note.
  const opening = () => (fence === null ? '' : fence.marker + fence.hint + '\n');
  const flush = () => {
    if (cur.trim() && cur !== opening())
      posts.push(cur.replace(/\n$/, '') + (fence !== null ? '\n' + fence.marker : ''));
    cur = opening();
  };
  for (let line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (posts.length >= maxPosts) {
      cut = true;
      break;
    }
    const fenceLine = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    const nextFence: { marker: string; hint: string } | null =
      fenceLine &&
      fence === null &&
      fenceLine[1].length <= 16 &&
      !(fenceLine[1][0] === '`' && fenceLine[2].includes('`'))
        ? { marker: fenceLine[1], hint: fenceLine[2].trim().slice(0, 32) }
        : null;
    if (nextFence) line = nextFence.marker + nextFence.hint;
    if (cur.length + line.length + 1 > budget && cur.trim() && cur !== opening()) flush();
    while (line.length > budget - cur.length) {
      let end = budget - cur.length;
      // Do not split a UTF-16 surrogate pair (emoji and non-BMP characters).
      if (end > 0 && /[\uD800-\uDBFF]/.test(line[end - 1]) && /[\uDC00-\uDFFF]/.test(line[end] ?? '')) end--;
      cur += line.slice(0, end) + '\n';
      line = line.slice(end);
      flush();
      if (posts.length >= maxPosts) {
        cut = true;
        break;
      }
    }
    if (cut) break;
    if (cur.length + line.length + 1 > budget) flush();
    cur += line + '\n';
    if (fenceLine) {
      if (fence === null) fence = nextFence;
      else if (
        fenceLine[1][0] === fence.marker[0] &&
        fenceLine[1].length >= fence.marker.length &&
        !fenceLine[2].trim()
      )
        fence = null;
    }
  }
  if (!cut) flush();
  if (cut && posts.length > 0) posts[posts.length - 1] += '\n*(The message continues in the tab.)*';
  return posts.slice(0, maxPosts);
}

/** Plain message compatibility: content remains below Discord's 2000-character limit. */
export function splitForDiscord(text: string, max = 1900, maxPosts = 8): string[] {
  if (max > 1900) throw new RangeError('Invalid Discord message chunk limits');
  return splitMarkdown(text, max, maxPosts);
}

/** Only style obvious prose, never fenced/indented code, inline code, URLs or Markdown links. */
function readableLine(line: string): string {
  // Mixed Markdown/URLs are left alone instead of guessing their token boundaries.
  if (line.includes('`') || line.includes('[') || line.includes(']') || /https?:\/\//.test(line)) return line;
  return line.replace(/\S+/g, (token) => {
    let start = 0,
      end = token.length;
    while (start < end && '("'.includes(token[start])) start++;
    while (end > start && '),;".'.includes(token[end - 1])) end--;
    const path = token.slice(start, end);
    const slash = path.lastIndexOf('/'),
      dot = path.lastIndexOf('.');
    if (
      slash < 0 ||
      path.startsWith('//') ||
      dot <= slash + 1 ||
      dot === path.length - 1 ||
      !/^[A-Za-z0-9_.~/-]+$/.test(path) ||
      !/^[A-Za-z0-9_-]+$/.test(path.slice(dot + 1))
    )
      return token;
    return token.slice(0, start) + '`' + path + '`' + token.slice(end);
  });
}
function inlineCodeState(line: string, initial: number): number {
  let ticks = initial;
  for (const match of line.matchAll(/`+/g)) {
    let slashes = 0;
    for (let at = match.index - 1; at >= 0 && line[at] === '\\'; at--) slashes++;
    if (slashes % 2) continue;
    if (!ticks) ticks = match[0].length;
    else if (ticks === match[0].length) ticks = 0;
  }
  return ticks;
}
export function formatDiscordResponseText(text: string): string {
  const out: string[] = [];
  let fence: { char: string; length: number } | undefined;
  let inlineTicks = 0;
  for (const original of formatDiscordTables(text).split('\n')) {
    if (inlineTicks) {
      inlineTicks = inlineCodeState(original, inlineTicks);
      out.push(original);
      continue;
    }
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(original);
    if (fence) {
      out.push(original);
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim())
        fence = undefined;
      continue;
    }
    if (marker && !(marker[1][0] === '`' && marker[2].includes('`'))) {
      fence = { char: marker[1][0], length: marker[1].length };
      out.push(original);
      continue;
    }
    if (!fence && !/^(?: {4}|\t|>)/.test(original) && original.includes('`')) {
      inlineTicks = inlineCodeState(original, 0);
    }
    if (original.length > 8192 || /^(?: {4}|\t|>)/.test(original) || original.includes('`')) {
      out.push(original);
      continue;
    }
    const item = /^(\d+[.)] )(.*)$/.exec(original);
    let line = original;
    if (item) {
      const label = /^([\p{L}][\p{L}\p{N} &/()_-]{0,59}:)(?=\s|$)/u.exec(item[2]);
      if (label) line = item[1] + '**' + label[1] + '**' + item[2].slice(label[1].length);
      if (out.length && out.at(-1)?.trim()) out.push('');
    }
    out.push(readableLine(line));
  }
  return out.join('\n');
}

/** Chat-width response text; only the first part can ping, and body URLs never unfurl. */
export function discordResponsePosts(
  text: string,
  options: {
    title?: string;
    color?: number;
    users?: string[];
  } = {}
): DiscordPost[] {
  const users = options.users ?? [];
  const severity =
    options.color === DISCORD_CRITICAL_COLOR ? '🔴 ' : options.color === DISCORD_WARNING_COLOR ? '⚠️ ' : '';
  const title = (options.title ?? 'Response').slice(0, 120);
  const mentions = users.map((id) => `<@${id}>`).join(' ');
  const heading = `${mentions ? mentions + '\n' : ''}**${severity}${title}**\n\n`;
  const chunks = splitMarkdown(heading + formatDiscordResponseText(text), 1900);
  return chunks.map((content, index) => ({
    content: content + (chunks.length > 1 ? `\n-# ${index + 1} / ${chunks.length}` : ''),
    flags: 4, // SUPPRESS_EMBEDS: retain links without replacing the narrow card with link previews.
    allowed_mentions: { parse: [], users: index === 0 ? users : [] },
  }));
}
