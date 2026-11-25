import { afterEach, expect, it, vi } from 'vitest';
import { TmuxCaptureBatcher } from '../src/tmux-capture-batcher.js';
import { TmuxManager } from '../src/tmux-manager.js';
import type { TmuxPaneTextExecutor } from '../src/tmux-manager.js';
const batches: TmuxCaptureBatcher[] = [];
const frames = new Map<string, string>();
const output = (args: string[]) => {
  let text = '';
  for (let i = 2; i < args.length; i++) {
    if (args[i] === 'display-message') {
      text += args[i + 2] + '\n';
      i += 2;
    } else if (args[i] === 'capture-pane') {
      const at = args.indexOf('-t', i),
        target = args[at + 1];
      if (!frames.has(target)) throw new Error('pane missing');
      text += frames.get(target);
      i = at + 1;
    }
  }
  return { stdout: text };
};
const make = (execute: TmuxPaneTextExecutor) => {
  const b = new TmuxCaptureBatcher('codeman-fixture', execute);
  batches.push(b);
  return b;
};
afterEach(() => {
  for (const b of batches.splice(0)) b.close();
  frames.clear();
  vi.useRealTimers();
});
it('captures sixteen distinct panes in four bounded commands with exact ANSI and blank-line preservation', async () => {
  let active = 0,
    maximum = 0;
  const execute = vi.fn<TmuxPaneTextExecutor>().mockImplementation(async (_file, args, opts) => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    expect(opts.maxBuffer).toBeLessThanOrEqual(4 * 256 * 1024 + 2048);
    return output(args);
  });
  const batch = make(execute);
  const names = Array.from({ length: 16 }, (_, i) => `codeman-${i}`);
  names.forEach((name) => frames.set(name, `\x1b[90m${name}\n\n`));
  expect(await Promise.all(names.map((name) => batch.capture(name, { ansi: true })))).toEqual(
    names.map((name) => frames.get(name))
  );
  expect(execute).toHaveBeenCalledTimes(4);
  expect(maximum).toBeLessThanOrEqual(2);
});
it('isolates a disappeared pane with fresh individual retries', async () => {
  frames.set('codeman-live', 'question\n');
  const execute = vi.fn<TmuxPaneTextExecutor>().mockImplementation(async (_file, args) => output(args));
  const batch = make(execute);
  expect(await Promise.all([batch.capture('codeman-gone'), batch.capture('codeman-live')])).toEqual([
    null,
    'question\n',
  ]);
  expect(execute).toHaveBeenCalledTimes(3);
});
it('cancels one subscriber without cancelling a shared capture', async () => {
  let release!: () => void;
  let shared!: AbortSignal;
  frames.set('codeman-a', 'a\n');
  frames.set('codeman-b', 'b\n');
  const execute = vi.fn<TmuxPaneTextExecutor>().mockImplementation(async (_file, args, opts) => {
    shared = opts.signal!;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return output(args);
  });
  const batch = make(execute),
    controller = new AbortController();
  const a = batch.capture('codeman-a', { signal: controller.signal }),
    b = batch.capture('codeman-b');
  await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
  controller.abort();
  expect(await a).toBeNull();
  expect(shared.aborted).toBe(false);
  release();
  expect(await b).toBe('b\n');
});
it('dispatches a fresh request after input/resize even while the preceding capture is pending', async () => {
  let release!: (value: { stdout: string }) => void;
  const execute = vi
    .fn<TmuxPaneTextExecutor>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    )
    .mockResolvedValue({ stdout: 'new\n' });
  const batch = make(execute),
    old = batch.capture('codeman-a');
  await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
  expect(await batch.capture('codeman-a')).toBe('new\n');
  release({ stdout: 'old\n' });
  expect(await old).toBe('old\n');
});
it('refuses invalid targets and oversized frames, then immediately retries fresh', async () => {
  const execute = vi
    .fn<TmuxPaneTextExecutor>()
    .mockResolvedValueOnce({ stdout: 'x'.repeat(256 * 1024 + 1) })
    .mockResolvedValue({ stdout: 'fresh\n' });
  const batch = make(execute);
  expect(await batch.capture('bad; inject')).toBeNull();
  expect(execute).not.toHaveBeenCalled();
  expect(await batch.capture('codeman-a')).toBeNull();
  expect(await batch.capture('codeman-a')).toBe('fresh\n');
});
it('enforces request deadlines and shutdown without stale results', async () => {
  vi.useFakeTimers();
  const execute = vi.fn<TmuxPaneTextExecutor>().mockImplementation(() => new Promise(() => {}));
  const batch = make(execute),
    pending = batch.capture('codeman-a');
  await vi.advanceTimersByTimeAsync(1501);
  expect(await pending).toBeNull();
  batch.close();
  expect(await batch.capture('codeman-a')).toBeNull();
});

it('routes the manager production path through bounded batching', async () => {
  const execute = vi.fn<TmuxPaneTextExecutor>().mockImplementation(async (_file, args) => output(args));
  const manager = new TmuxManager({ paneTextExecutor: execute });
  const before = process.env.VITEST;
  try {
    // Module-level test isolation still prevents state loading; only this read dispatcher uses its production branch.
    delete process.env.VITEST;
    const names = ['codeman-aaaaaaaa', 'codeman-bbbbbbbb', 'codeman-cccccccc', 'codeman-dddddddd'];
    names.forEach((name) => frames.set(name, name + '\n'));
    expect(await Promise.all(names.map((name) => manager.capturePaneTextAsync(name)))).toEqual(
      names.map((name) => name + '\n')
    );
    expect(execute).toHaveBeenCalledOnce();
  } finally {
    process.env.VITEST = before;
    manager.destroy();
  }
});
