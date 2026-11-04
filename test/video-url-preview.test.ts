import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

function method(file: string, name: string) {
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public', file), 'utf8');
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let result = '';
  function visit(node: ts.Node) {
    if (ts.isMethodDeclaration(node) && node.name.getText(tree) === name) result = node.getText(tree);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  if (!result) throw new Error(`Missing ${name}`);
  return result;
}

describe('direct video link routing', () => {
  it.each([
    'javascript:alert(1)',
    'data:video/mp4;base64,AAAA',
    'file:///tmp/movie.mp4',
    'ftp://example.test/movie.mp4',
    'https://user:password@example.test/movie.mp4',
    'https://example.test/page?file=movie.mp4',
    'https://example.test/movie.mp4.html',
    'https://example.test/movie',
    'https://',
    null,
    '/workspace/movie.mp4',
  ])('does not embed an unsupported or credential-bearing URL: %s', (url) => {
    const open = vm.runInNewContext(`({${method('panels-ui.js', 'openVideoUrlPreview')}})`, { URL });
    const host = { $: vi.fn(), activeSessionId: null };
    expect(open.openVideoUrlPreview.call(host, url)).toBe(false);
    expect(host.$).not.toHaveBeenCalled();
  });

  it('consumes a video link without opening a new browser tab', () => {
    const external = vi.fn();
    const host = {
      openLinkThroughWebTabIfLoopback: vi.fn(() => false),
      openVideoUrlPreview: vi.fn(() => true),
    };
    const opener = vm.runInNewContext(`({${method('terminal-ui.js', '_openTerminalUrl')}})`, {
      window: { open: external },
    });
    opener._openTerminalUrl.call(host, 'https://example.test/movie.mp4');
    expect(host.openVideoUrlPreview).toHaveBeenCalledWith('https://example.test/movie.mp4');
    expect(external).not.toHaveBeenCalled();
  });

  it('preserves the loopback proxy and ordinary external-link behavior', () => {
    const external = vi.fn();
    const host = { openLinkThroughWebTabIfLoopback: vi.fn(() => true), openVideoUrlPreview: vi.fn(() => false) };
    const opener = vm.runInNewContext(`({${method('terminal-ui.js', '_openTerminalUrl')}})`, {
      window: { open: external },
    });
    opener._openTerminalUrl.call(host, 'http://localhost:8080/movie.mp4');
    expect(host.openVideoUrlPreview).not.toHaveBeenCalled();
    host.openLinkThroughWebTabIfLoopback.mockReturnValue(false);
    opener._openTerminalUrl.call(host, 'https://example.test/docs');
    expect(external).toHaveBeenCalledWith('https://example.test/docs', '_blank', 'noopener,noreferrer');
  });
});
