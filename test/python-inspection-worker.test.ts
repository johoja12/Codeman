import { afterEach, expect, it } from 'vitest';
import { PythonInspectionWorker } from '../src/python-inspection-worker.js';
const workers: PythonInspectionWorker[] = [];
const make = (source: string, timeout = 5000, idle = 30000) => {
  const worker = new PythonInspectionWorker(source, timeout, idle);
  workers.push(worker);
  return worker;
};
afterEach(() => {
  for (const worker of workers.splice(0)) worker.close();
});
const decode = (buffer: Buffer | undefined) => JSON.parse(buffer!.toString());
it('reuses initialization while keeping globals and argv fresh for each invocation', async () => {
  const worker = make(
    "import os,sys,json\nn=globals().get('n',0)+1\nprint(json.dumps({'pid':os.getpid(),'n':n,'args':sys.argv[1:]}))"
  );
  const first = decode(await worker.read(['first']));
  const second = decode(await worker.read(['second']));
  expect(second).toEqual({ pid: first.pid, n: 1, args: ['second'] });
});
it('bounds concurrency to two interpreters across a burst', async () => {
  const worker = make('import os,time\ntime.sleep(0.02)\nprint(os.getpid())');
  const values = await Promise.all(Array.from({ length: 16 }, () => worker.read([])));
  expect(values.every(Boolean)).toBe(true);
  expect(new Set(values.map((value) => value!.toString())).size).toBeLessThanOrEqual(2);
});
it('does not cache probe failures or oversized output', async () => {
  const worker = make(
    "import sys\nif sys.argv[1]=='large':print('x'*20000)\nelif sys.argv[1]=='fail':sys.exit(1)\nelse:print(sys.argv[1])"
  );
  expect(await worker.read(['large'])).toBeUndefined();
  expect(await worker.read(['fail'])).toBeUndefined();
  expect((await worker.read(['fresh']))?.toString()).toBe('fresh\n');
});
it('restarts after helper death without replaying the failed request', async () => {
  const worker = make("import os,sys\nif sys.argv[1]=='crash':os._exit(1)\nprint(sys.argv[1])");
  expect(await worker.read(['crash'])).toBeUndefined();
  expect((await worker.read(['next']))?.toString()).toBe('next\n');
});
it('bounds a hung request and makes subsequent probes fresh', async () => {
  const worker = make("import time,sys\ntime.sleep(float(sys.argv[1]))\nprint('fresh')", 1000);
  expect(await worker.read(['3'])).toBeUndefined();
  expect((await worker.read(['0']))?.toString()).toBe('fresh\n');
});
it('closes pending work and refuses new requests after shutdown', async () => {
  const worker = make("import time\ntime.sleep(5)\nprint('late')");
  const requests = [worker.read([]), worker.read([]), worker.read([])];
  worker.close();
  expect(await Promise.all(requests)).toEqual([undefined, undefined, undefined]);
  expect(await worker.read([])).toBeUndefined();
});
