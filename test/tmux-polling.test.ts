import { describe, expect, it, vi } from 'vitest';
import { TmuxManager, parsePollingPanes, type TmuxPaneTextExecutor } from '../src/tmux-manager.js';

const names = Array.from({ length: 16 }, (_, i) => `codeman-${i.toString(16).padStart(8, '0')}`);
const inventory = names.map((name, i) => `${name}|1|%${i}|0|${1000 + i}|120|40|1|${i % 2}`).join('\n');

describe('tmux polling batching', () => {
  it('answers 32 fresh status/geometry reads for 16 sessions with one shell-free inventory', async () => {
    const execute = vi.fn<TmuxPaneTextExecutor>().mockResolvedValue({ stdout: inventory });
    const mux = new TmuxManager({ paneTextExecutor: execute });
    const answers = await Promise.all(
      names.map(async (name, i) => {
        const [dead, panes] = await Promise.all([mux.isPaneDead(name), mux.listPanes(name)]);
        expect(dead).toBe(i % 2 === 1);
        expect(panes).toEqual([{ paneId: `%${i}`, paneIndex: 0, panePid: 1000 + i, width: 120, height: 40 }]);
      })
    );
    expect(answers).toHaveLength(16);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0][0]).toBe('tmux');
    expect(execute.mock.calls[0][1]).toContain('-a');
    // No snapshot retained across observations, including changed pid/dead/size.
    execute.mockResolvedValue({ stdout: `${names[0]}|1|%0|0|9999|80|20|1|1` });
    await expect(mux.isPaneDead(names[0])).resolves.toBe(true);
    await expect(mux.listPanes(names[0])).resolves.toMatchObject([{ panePid: 9999, width: 80, height: 20 }]);
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('batches the real mouse watcher tick and reconnect tick across 16 sessions', async () => {
    vi.useFakeTimers();
    const live = inventory.replace(/\|[01](?=\n|$)/g, '|0');
    const execute = vi.fn<TmuxPaneTextExecutor>().mockResolvedValue({ stdout: live });
    const mux = new TmuxManager({ paneTextExecutor: execute });
    for (const [i, name] of names.entries())
      mux.registerSession({
        sessionId: name.slice(8),
        muxName: name,
        pid: 1000 + i,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: 'shell',
        attached: true,
        remote: {
          hostId: 'fixture',
          label: 'fixture',
          host: 'fixture',
          username: 'fixture',
          remotePath: '/tmp',
          owned: true,
        },
      });
    const disable = vi.spyOn(mux, 'disableMouseMode').mockResolvedValue(true);
    try {
      mux.startMouseModeSync();
      await vi.advanceTimersByTimeAsync(5000);
      expect(execute).toHaveBeenCalledOnce();
      expect(disable).toHaveBeenCalledTimes(16);
      await vi.advanceTimersByTimeAsync(5000);
      expect(execute).toHaveBeenCalledTimes(2);
      expect(disable).toHaveBeenCalledTimes(16); // unchanged counts do not toggle again
      await mux.runRemoteReconnectTick(Date.now(), true);
      expect(execute).toHaveBeenCalledTimes(3);
    } finally {
      mux.stopMouseModeSync();
      vi.useRealTimers();
    }
  });

  it('discards a reconnect snapshot if a pane was replaced during the read', async () => {
    let release!: (result: { stdout: string }) => void;
    const execute = vi.fn<TmuxPaneTextExecutor>().mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const mux = new TmuxManager({ paneTextExecutor: execute });
    mux.registerSession({
      sessionId: '00000000',
      muxName: names[0],
      pid: 1000,
      createdAt: Date.now(),
      workingDir: '/tmp',
      mode: 'shell',
      attached: true,
      remote: {
        hostId: 'fixture',
        label: 'fixture',
        host: 'fixture',
        username: 'fixture',
        remotePath: '/tmp',
        owned: true,
      },
    });
    const dropped = vi.fn();
    mux.on('remoteSessionDropped', dropped);
    const pending = mux.runRemoteReconnectTick(Date.now(), true);
    await Promise.resolve();
    mux.clearPaneExit(names[0]);
    release({ stdout: `${names[0]}|1|%0|0|1000|80|24|1|1` });
    await pending;
    expect(dropped).not.toHaveBeenCalled();
  });

  it('uses the active pane in the active window and excludes inactive windows', async () => {
    const text = `${names[0]}|0|%9|0|999|80|24|1|1\n${names[0]}|1|%0|0|100|80|24|0|1\n${names[0]}|1|%1|1|101|80|24|1|0`;
    const mux = new TmuxManager({ paneTextExecutor: vi.fn().mockResolvedValue({ stdout: text }) });
    expect(await mux.isPaneDead(names[0])).toBe(false);
    expect(await mux.listPanes(names[0])).toHaveLength(2);
    expect(parsePollingPanes('malformed\nname|1|%0|x|1|80|24|1|1')).toEqual(new Map());
  });

  it('does not reuse an inventory already in flight across pane replacement', async () => {
    let release!: (result: { stdout: string }) => void;
    const execute = vi
      .fn<TmuxPaneTextExecutor>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          })
      )
      .mockResolvedValue({ stdout: `${names[0]}|1|%0|0|200|80|24|1|0` });
    const mux = new TmuxManager({ paneTextExecutor: execute });
    const before = mux.isPaneDead(names[0]);
    await Promise.resolve();
    mux.clearPaneExit(names[0]);
    await expect(mux.isPaneDead(names[0])).resolves.toBe(false);
    release({ stdout: `${names[0]}|1|%0|0|100|80|24|1|1` });
    await expect(before).resolves.toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('returns conservative failure answers, retries immediately, and does not spawn for invalid targets', async () => {
    const execute = vi
      .fn<TmuxPaneTextExecutor>()
      .mockRejectedValueOnce(new Error('missing socket'))
      .mockResolvedValue({ stdout: inventory });
    const mux = new TmuxManager({ paneTextExecutor: execute });
    await expect(mux.listPanes(names[0])).resolves.toEqual([]);
    await expect(mux.listPanes(names[0])).resolves.toHaveLength(1);
    await expect(mux.isPaneDead('bad; target')).resolves.toBe(false);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('coalesces queued captures but reads again after dispatch and keeps ANSI modes separate', async () => {
    let release!: (result: { stdout: string }) => void;
    const execute = vi
      .fn<TmuxPaneTextExecutor>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          })
      )
      .mockResolvedValue({ stdout: 'new frame' });
    const mux = new TmuxManager({ paneTextExecutor: execute });
    const first = mux.capturePaneTextAsync(names[0]);
    const duplicate = mux.capturePaneTextAsync(names[0]);
    await Promise.resolve();
    // Simulates a fresh check following input/resize while the old capture is pending.
    await expect(mux.capturePaneTextAsync(names[0])).resolves.toBe('new frame');
    release({ stdout: 'old frame' });
    expect(await Promise.all([first, duplicate])).toEqual(['old frame', 'old frame']);
    expect(execute).toHaveBeenCalledTimes(2);
    await Promise.all([mux.capturePaneTextAsync(names[0]), mux.capturePaneTextAsync(names[0], { ansi: true })]);
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it('isolates cancellation from another consumer of the same pane', async () => {
    const controller = new AbortController();
    const execute = vi.fn<TmuxPaneTextExecutor>().mockImplementation(async (_file, _args, options) => {
      if (options.signal) {
        controller.abort();
        throw new Error('aborted');
      }
      return { stdout: 'fresh question' };
    });
    const mux = new TmuxManager({ paneTextExecutor: execute });
    const answers = await Promise.all([
      mux.capturePaneTextAsync(names[0]),
      mux.capturePaneTextAsync(names[0], { signal: controller.signal }),
    ]);
    expect(answers).toEqual(['fresh question', null]);
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
