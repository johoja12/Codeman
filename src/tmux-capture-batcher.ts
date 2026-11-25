/** Fresh bounded multi-pane reads. No completed or in-flight frame is reused by a later request. */
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { SAFE_TMUX_SOCKET_PATTERN } from './config/instance.js';
import type { TmuxPaneTextExecutor } from './tmux-manager.js';

const LIMIT = 256 * 1024;
interface Request {
  target: string;
  ansi: boolean;
  signal?: AbortSignal;
  deadline: number;
  done: boolean;
  finish: (text: string | null) => void;
  cancelGroup?: () => void;
}
export class TmuxCaptureBatcher {
  private readonly queue: Request[] = [];
  private readonly requests = new Set<Request>();
  private timer?: NodeJS.Timeout;
  private active = 0;
  private closed = false;
  constructor(
    private readonly socket: string,
    private readonly execute: TmuxPaneTextExecutor
  ) {}

  capture(target: string, options?: { ansi?: boolean; signal?: AbortSignal }): Promise<string | null> {
    if (
      this.closed ||
      this.requests.size >= 64 ||
      options?.signal?.aborted ||
      !SAFE_TMUX_SOCKET_PATTERN.test(this.socket) ||
      !/^[A-Za-z0-9_-]+$/.test(target)
    )
      return Promise.resolve(null);
    return new Promise((resolve) => {
      const request: Request = {
        target,
        ansi: options?.ansi === true,
        signal: options?.signal,
        deadline: performance.now() + 1500,
        done: false,
        finish: () => undefined,
      };
      const abort = () => {
        request.finish(null);
        request.cancelGroup?.();
      };
      const timeout = setTimeout(abort, 1500);
      request.finish = (text) => {
        if (request.done) return;
        request.done = true;
        clearTimeout(timeout);
        request.signal?.removeEventListener('abort', abort);
        this.requests.delete(request);
        resolve(text);
      };
      request.signal?.addEventListener('abort', abort, { once: true });
      this.requests.add(request);
      this.queue.push(request);
      this.schedule();
    });
  }

  private schedule(): void {
    if (this.closed || this.timer || this.active >= 2 || !this.queue.length) return;
    // A 4ms dispatch window combines independently queued reads, not old frame results.
    this.timer = setTimeout(() => {
      this.timer = undefined;
      while (this.active < 2 && this.queue.length) {
        const jobs = this.queue.splice(0, 4).filter((job) => !job.done);
        if (!jobs.length) continue;
        this.active++;
        void this.run(jobs).finally(() => {
          this.active--;
          this.schedule();
        });
      }
    }, 4);
  }

  private async one(job: Request): Promise<void> {
    if (job.done) return;
    try {
      const { stdout } = await this.execute(
        'tmux',
        ['-L', this.socket, 'capture-pane', '-p', ...(job.ansi ? ['-e'] : []), '-t', job.target],
        {
          encoding: 'utf8',
          timeout: Math.max(1, Math.ceil(job.deadline - performance.now())),
          maxBuffer: LIMIT,
          ...(job.signal ? { signal: job.signal } : {}),
        }
      );
      job.finish(Buffer.byteLength(stdout, 'utf8') <= LIMIT ? stdout : null);
    } catch {
      job.finish(null);
    }
  }

  private async run(jobs: Request[]): Promise<void> {
    if (jobs.length === 1) {
      await this.one(jobs[0]);
      return;
    }
    const controller = new AbortController();
    const cancel = () => {
      if (jobs.every((job) => job.done)) controller.abort();
    };
    for (const job of jobs) job.cancelGroup = cancel;
    const token = randomUUID().replace(/-/g, '');
    const args = ['-L', this.socket];
    const begin = (i: number) => `__CODEMAN_${token}_${i}_BEGIN__\n`;
    const end = (i: number) => `__CODEMAN_${token}_${i}_END__\n`;
    jobs.forEach((job, index) => {
      if (index) args.push(';');
      args.push(
        'display-message',
        '-p',
        begin(index).trimEnd(),
        ';',
        'capture-pane',
        '-p',
        ...(job.ansi ? ['-e'] : []),
        '-t',
        job.target,
        ';',
        'display-message',
        '-p',
        end(index).trimEnd()
      );
    });
    try {
      const { stdout } = await this.execute('tmux', args, {
        encoding: 'utf8',
        timeout: Math.max(1, Math.ceil(Math.min(...jobs.map((job) => job.deadline)) - performance.now())),
        maxBuffer: LIMIT * jobs.length + 2048,
        signal: controller.signal,
      });
      const frames: string[] = [];
      let cursor = 0;
      jobs.forEach((_job, index) => {
        if (!stdout.startsWith(begin(index), cursor)) throw new Error('batch framing');
        cursor += begin(index).length;
        const at = stdout.indexOf(end(index), cursor);
        if (at < 0) throw new Error('batch framing');
        const frame = stdout.slice(cursor, at);
        if (Buffer.byteLength(frame, 'utf8') > LIMIT) throw new Error('frame limit');
        frames.push(frame);
        cursor = at + end(index).length;
      });
      if (cursor !== stdout.length) throw new Error('batch framing');
      jobs.forEach((job, index) => job.finish(frames[index]));
    } catch {
      // tmux stops a command list at a vanished pane. Retry each remaining
      // request independently, within its ORIGINAL deadline, so healthy panes still answer.
      // Sequential fallback keeps this batch within the global two-client cap.
      for (const job of jobs) await this.one(job);
    } finally {
      for (const job of jobs) job.cancelGroup = undefined;
    }
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.queue.length = 0;
    for (const job of this.requests) {
      job.finish(null);
      job.cancelGroup?.();
    }
  }
}
