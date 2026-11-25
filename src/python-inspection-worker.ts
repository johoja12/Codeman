/** Bounded interpreter reuse for trusted, read-only probes. Every invocation has fresh globals and argv. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

const WORKER = String.raw`
import sys,json,io,contextlib,base64
code=compile(sys.argv[1],'<native-inspection>','exec')
reader=sys.stdin;writer=sys.stdout;original_argv=sys.argv
class Output(io.StringIO):
 def write(self,value):
  if self.tell()+len(value)>16384:raise ValueError('output limit')
  return super().write(value)
for line in reader:
 try:
  if len(line)>16384:raise ValueError('request limit')
  request=json.loads(line);args=request['args']
  if not isinstance(args,list) or not all(isinstance(a,str) for a in args):raise ValueError('args')
  sys.argv=['native-inspection']+args;out=Output()
  with contextlib.redirect_stdout(out),contextlib.redirect_stderr(Output()):
   try:exec(code,{'__name__':'__main__'})
   except SystemExit as e:
    if e.code not in (None,0):raise ValueError('probe failed')
  data=out.getvalue().encode('utf-8')
  if len(data)>16384:raise ValueError('output limit')
  response={'ok':True,'data':base64.b64encode(data).decode('ascii')}
 except BaseException:response={'ok':False}
 finally:sys.argv=original_argv
 writer.write(json.dumps(response)+'\n');writer.flush()
`;
interface Job {
  args: string[];
  done: boolean;
  finish: (value: Buffer | undefined) => void;
}
interface Slot {
  child: ChildProcessWithoutNullStreams;
  job?: Job;
  bytes: Buffer;
  dead: boolean;
  stderr: number;
  idle?: NodeJS.Timeout;
}
export class PythonInspectionWorker {
  private readonly slots = new Set<Slot>();
  private readonly queue: Job[] = [];
  private closed = false;
  constructor(
    private readonly source: string,
    private readonly timeoutMs = 15_000,
    private readonly idleMs = 30_000
  ) {}

  read(args: string[]): Promise<Buffer | undefined> {
    if (this.closed || this.queue.length >= 32 || Buffer.byteLength(JSON.stringify(args)) > 8192)
      return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const job: Job = { args, done: false, finish: () => undefined };
      const timeout = setTimeout(() => {
        job.finish(undefined);
        const slot = [...this.slots].find((s) => s.job === job);
        if (slot) this.retire(slot);
        this.pump();
      }, this.timeoutMs);
      job.finish = (value) => {
        if (job.done) return;
        job.done = true;
        clearTimeout(timeout);
        resolve(value);
      };
      this.queue.push(job);
      this.pump();
    });
  }

  private pump(): void {
    if (this.closed) return;
    while (this.queue.length) {
      if (this.queue[0].done) {
        this.queue.shift();
        continue;
      }
      let slot = [...this.slots].find((s) => !s.job && !s.dead);
      if (!slot) {
        if (this.slots.size >= 2) return;
        slot = this.start();
      }
      if (slot.idle) clearTimeout(slot.idle);
      slot.job = this.queue.shift()!;
      slot.child.stdin.write(JSON.stringify({ args: slot.job.args }) + '\n', (error) => {
        if (error) this.retire(slot!);
      });
    }
  }

  private start(): Slot {
    const child = spawn('python3', ['-u', '-c', WORKER, this.source], { stdio: ['pipe', 'pipe', 'pipe'] });
    const slot: Slot = { child, bytes: Buffer.alloc(0), dead: false, stderr: 0 };
    this.slots.add(slot);
    child.on('error', () => this.retire(slot));
    child.on('exit', () => this.retire(slot));
    child.stdin.on('error', () => this.retire(slot));
    child.stdout.on('data', (chunk: Buffer) => {
      if (slot.dead) return;
      if (slot.bytes.length + chunk.length > 32_768) {
        this.retire(slot);
        return;
      }
      slot.bytes = Buffer.concat([slot.bytes, chunk]);
      const end = slot.bytes.indexOf(10);
      if (end < 0) return;
      if (!slot.job || end !== slot.bytes.length - 1) {
        this.retire(slot);
        return;
      }
      try {
        const packet = JSON.parse(slot.bytes.subarray(0, end).toString('utf8')) as { ok?: boolean; data?: string };
        let value: Buffer | undefined;
        if (packet.ok) {
          if (typeof packet.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(packet.data))
            throw new Error('protocol');
          value = Buffer.from(packet.data, 'base64');
          if (value.length > 16_384) throw new Error('output limit');
        }
        slot.bytes = Buffer.alloc(0);
        slot.job.finish(value);
        slot.job = undefined;
        slot.idle = setTimeout(() => this.retire(slot), this.idleMs);
        slot.idle.unref();
        this.pump();
      } catch {
        this.retire(slot);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      slot.stderr += chunk.length;
      if (slot.stderr > 65_536) this.retire(slot);
    });
    return slot;
  }

  private retire(slot: Slot): void {
    if (slot.dead) return;
    slot.dead = true;
    if (slot.idle) clearTimeout(slot.idle);
    slot.job?.finish(undefined);
    this.slots.delete(slot);
    // Only this class's own read-only helper is terminated, never a native agent.
    slot.child.stdin.destroy();
    slot.child.stdout.destroy();
    slot.child.stderr.destroy();
    slot.child.kill('SIGTERM');
    slot.child.unref();
    this.pump();
  }

  close(): void {
    this.closed = true;
    for (const job of this.queue.splice(0)) job.finish(undefined);
    for (const slot of this.slots) this.retire(slot);
  }
}
