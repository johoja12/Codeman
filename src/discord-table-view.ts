/** @fileoverview Bounded, data-only Discord table views and exports. No HTML or external resources are evaluated. */
import type { DiscordTable } from './discord-tables.js';

export function interactiveDiscordTable(table: DiscordTable): boolean {
  return (
    table.header.length > 0 &&
    table.header.length <= 24 &&
    table.rows.length > 0 &&
    table.rows.length <= 200 &&
    [table.header, ...table.rows].reduce((n, row) => n + row.join('').length, 0) <= 64 * 1024
  );
}
export function discordTablePage(table: DiscordTable, page: number): Array<Record<string, unknown>> {
  const pages = Math.ceil(table.rows.length / 3);
  if (!Number.isInteger(page) || page < 0 || page >= pages) throw new Error('Invalid table page');
  const start = page * 3;
  const components: Array<Record<string, unknown>> = [
    {
      type: 10,
      content: `**${table.header[0] || 'Item'}**${table.header.length > 1 ? '\n-# ' + table.header.slice(1).join(' · ') : ''}`,
    },
  ];
  for (const [i, r] of table.rows.slice(start, start + 3).entries()) {
    if (i) components.push({ type: 14, divider: true, spacing: 1 });
    // Preserve source Markdown and column order; never infer statuses or discard fields.
    const first = r[0] || '—';
    components.push({
      type: 10,
      content: `${first.includes('`') || first.includes('**') ? first : '**' + first + '**'}${
        r.length > 1
          ? '\n' +
            r
              .slice(1)
              .map((v) => v || '—')
              .join(' · ')
          : ''
      }`,
    });
  }
  components.push({
    type: 10,
    content: `-# Showing ${start + 1}–${Math.min(start + 3, table.rows.length)} of ${table.rows.length}`,
  });
  return components;
}
export function discordTableCsv(table: DiscordTable): Buffer {
  // RFC 4180 quoting plus spreadsheet formula-injection protection. Markdown is retained verbatim.
  const cell = (s: string) => '"' + (/^[\s]*[=+\-@\t\r]/.test(s) ? "'" + s : s).replace(/"/g, '""') + '"';
  return Buffer.from('\uFEFF' + [table.header, ...table.rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n');
}
const xml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
/** Plain text only in SVG: links, images and SVG markup from cells cannot load resources. */
const plain = (s: string) =>
  s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`+/g, '')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f]/g, ' ');
export function discordTableSvg(table: DiscordTable, page?: number): string {
  if (!interactiveDiscordTable(table))
    throw new Error('Table is too large for an image preview. Download CSV instead.');
  if (page !== undefined) discordTablePage(table, page); // Validate before slicing.
  const start = page === undefined ? 0 : page * 3;
  const rows = page === undefined ? table.rows : table.rows.slice(start, start + 3);
  const cols = table.header.length,
    width = Math.max(720, Math.min(2400, cols * 280)),
    colWidth = (width - 48) / cols;
  const wrap = (s: string) => {
    const chars = Array.from(plain(s)),
      n = Math.max(3, Math.floor((colWidth - 24) / 12));
    const lines: string[] = [];
    while (chars.length) {
      let width = 0,
        count = 0;
      while (count < chars.length) {
        const units = chars[count].codePointAt(0)! > 0x2ff ? 2 : 1;
        if (width + units > n) break;
        width += units;
        count++;
      }
      count = Math.max(1, count);
      if (count < chars.length) {
        const space = chars.slice(0, count).lastIndexOf(' ');
        if (space > count / 2) count = space + 1;
      }
      lines.push(chars.splice(0, count).join('').trim());
    }
    return lines.length ? lines : [''];
  };
  let y = 74;
  const body: string[] = [];
  for (const [index, r] of [table.header, ...rows].entries()) {
    const lines = r.map(wrap),
      height = Math.max(...lines.map((l) => l.length)) * 25 + 28;
    if (y + height > 4096) throw new Error('Table preview is too tall. Download CSV instead.');
    body.push(
      `<rect x="24" y="${y}" width="${width - 48}" height="${height}" fill="${index === 0 ? '#35404d' : index % 2 ? '#25282e' : '#2c3037'}"/>`
    );
    lines.forEach((ls, col) =>
      ls.forEach((line, n) =>
        body.push(
          `<text x="${36 + col * colWidth}" y="${y + 28 + n * 25}" fill="${index === 0 ? '#9ccaff' : '#e7e9ee'}" font-size="18"${index === 0 ? ' font-weight="bold"' : ''}>${xml(line)}</text>`
        )
      )
    );
    y += height + 2;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${y + 48}" font-family="DejaVu Sans Mono, monospace"><rect width="100%" height="100%" fill="#1e2025"/><text x="24" y="44" font-size="24" fill="#e7e9ee">Table · rows ${start + 1}–${start + rows.length} of ${table.rows.length}</text>${body.join('')}<text x="24" y="${y + 30}" font-size="16" fill="#a5acb8">Codeman · Download CSV for all rows and original cell text</text></svg>`;
}
export async function discordTablePng(table: DiscordTable, page: number): Promise<Buffer> {
  const { Resvg } = await import('@resvg/resvg-js');
  let svg: string;
  try {
    svg = discordTableSvg(table);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('Table preview is too tall')) throw error;
    svg = discordTableSvg(table, page);
  }
  return new Resvg(svg, { font: { loadSystemFonts: true } }).render().asPng();
}

/** Bounded table pages with repeated headers; oversized rows continue without losing cell text. */
export function discordTableImagePages(table: DiscordTable): string[] {
  if (!interactiveDiscordTable(table)) throw new Error('Table exceeds preview limits');
  const width = Math.max(900, Math.min(3200, table.header.length * 360));
  const colWidth = (width - 48) / table.header.length;
  const wrap = (text: string): string[] => {
    const chars = Array.from(plain(text));
    const lines: string[] = [];
    const budget = Math.max(3, Math.floor((colWidth - 28) / 12));
    while (chars.length) {
      let units = 0,
        count = 0;
      while (count < chars.length && units + (chars[count].codePointAt(0)! > 0x2ff ? 2 : 1) <= budget) {
        units += chars[count].codePointAt(0)! > 0x2ff ? 2 : 1;
        count++;
      }
      count = Math.max(1, count);
      const space = chars.slice(0, count).lastIndexOf(' ');
      if (count < chars.length && space > count / 2) count = space + 1;
      lines.push(chars.splice(0, count).join('').trim());
    }
    return lines.length ? lines : [''];
  };
  const header = table.header
    .map(wrap)
    .map((lines) => (lines.length > 8 ? [...lines.slice(0, 7), '… (full header in CSV)'] : lines));
  const rowHeight = (cells: string[][]) => Math.max(...cells.map((c) => c.length)) * 28 + 24;
  const headerHeight = rowHeight(header);
  const maxLines = Math.max(1, Math.floor((2200 - 160 - headerHeight) / 28) - 1);
  const pages: Array<{ rows: Array<{ cells: string[][]; index: number }>; first: number; last: number }> = [];
  let page = { rows: [] as Array<{ cells: string[][]; index: number }>, first: 0, last: 0 };
  let height = 100 + headerHeight;
  table.rows.forEach((row, index) => {
    const cells = row.map(wrap);
    const lines = Math.max(...cells.map((c) => c.length));
    for (let offset = 0; offset < lines; offset += maxLines) {
      const fragment = cells.map((c) => c.slice(offset, offset + maxLines));
      const size = rowHeight(fragment) + 2;
      if (page.rows.length && height + size > 2140) {
        pages.push(page);
        page = { rows: [], first: index, last: index };
        height = 100 + headerHeight;
      }
      if (!page.rows.length) page.first = index;
      page.last = index;
      page.rows.push({ cells: fragment, index });
      height += size;
    }
  });
  if (page.rows.length) pages.push(page);
  return pages.map((page, pageIndex) => {
    let y = 76;
    const body: string[] = [];
    const draw = (cells: string[][], index: number) => {
      const h = rowHeight(cells);
      body.push(
        `<rect x="24" y="${y}" width="${width - 48}" height="${h}" fill="${index < 0 ? '#303e52' : index % 2 ? '#242a34' : '#1c222c'}"/>`
      );
      cells.forEach((lines, col) => {
        if (col) body.push(`<path d="M${24 + col * colWidth} ${y}v${h}" stroke="#435064" stroke-width="1"/>`);
        lines.forEach((line, n) =>
          body.push(
            `<text x="${38 + col * colWidth}" y="${y + 31 + n * 28}" font-size="20" fill="${index < 0 ? '#b7d7ff' : '#edf2fa'}"${index < 0 ? ' font-weight="bold"' : ''}>${xml(line)}</text>`
          )
        );
      });
      y += h + 2;
    };
    draw(header, -1);
    page.rows.forEach((row) => draw(row.cells, row.index));
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${y + 54}" font-family="DejaVu Sans, sans-serif"><rect width="100%" height="100%" fill="#141a23"/><text x="24" y="43" font-size="25" font-weight="bold" fill="#edf2fa">Table · rows ${page.first + 1}–${page.last + 1} of ${table.rows.length}</text>${body.join('')}<text x="24" y="${y + 33}" font-size="17" fill="#a8b5c7">${pageIndex + 1} / ${pages.length} · Codeman · Original data available as CSV</text></svg>`;
  });
}
export async function discordTableImage(table: DiscordTable, page: number): Promise<{ data: Buffer; pages: number }> {
  const images = discordTableImagePages(table);
  if (!Number.isInteger(page) || page < 0 || page >= images.length) throw new Error('Invalid table image page');
  const { Resvg } = await import('@resvg/resvg-js');
  return { data: new Resvg(images[page], { font: { loadSystemFonts: true } }).render().asPng(), pages: images.length };
}
