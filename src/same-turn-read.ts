/** Share reads requested before dispatch, never a completed or already-running read.
 * A request following input/resize/respawn therefore starts a fresh observation.
 */
export class SameTurnRead<T> {
  private readonly queued = new Map<string, Promise<T>>();

  read(key: string, execute: () => Promise<T>): Promise<T> {
    const existing = this.queued.get(key);
    if (existing) return existing;
    // Bound queued bookkeeping even for a burst of distinct targets.
    if (this.queued.size >= 128) return Promise.resolve().then(execute);
    // Dispatch in the next microtask, without adding a polling interval or TTL.
    const pending = Promise.resolve().then(() => {
      this.queued.delete(key);
      return execute();
    });
    this.queued.set(key, pending);
    return pending;
  }
}
