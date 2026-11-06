/** Idempotent, serialized thread subscriptions. Never posts messages or creates destinations. */
export interface DiscordThreadMembership {
  scope: string;
  thread: string;
  users: string[];
  current(): boolean;
  verify(): Promise<boolean>;
}
export class DiscordThreadMembers {
  private due = new Map<string, number>();
  private pending = new Map<string, Promise<void>>();
  private queue: Promise<void> = Promise.resolve();
  constructor(
    private readonly add: (thread: string, user: string, current: () => boolean) => Promise<unknown>,
    private readonly now: () => number = Date.now
  ) {}
  reset(): void {
    this.due.clear();
  }
  ensure(target: DiscordThreadMembership): Promise<void> {
    const key = JSON.stringify([target.scope, target.thread]);
    const pending = this.pending.get(key);
    if (pending) return pending;
    if (!target.current() || !target.users.length) return Promise.resolve();
    if (this.pending.size >= 256) return Promise.reject(new Error('Thread membership queue is full'));
    const run = this.queue
      .then(async () => {
        const users = [...new Set(target.users)].filter(
          (user) => /^\d{15,25}$/.test(user) && (this.due.get(key + ':' + user) ?? 0) <= this.now()
        );
        if (!users.length || !target.current()) return;
        const defer = (user: string, ms: number) => {
          if (this.due.size >= 4096) this.due.delete(this.due.keys().next().value!);
          this.due.set(key + ':' + user, this.now() + ms);
        };
        try {
          if (!(await target.verify()) || !target.current()) {
            users.forEach((user) => defer(user, 30000));
            return;
          }
        } catch (error) {
          users.forEach((user) => defer(user, 30000));
          throw error;
        }
        let failure: unknown;
        for (const user of users) {
          if (!target.current()) return;
          try {
            await this.add(target.thread, user, target.current);
            if (target.current()) defer(user, 15 * 60000);
          } catch (error) {
            defer(user, 30000);
            failure = error;
          }
        }
        if (failure) throw failure;
      })
      .finally(() => {
        if (this.pending.get(key) === run) this.pending.delete(key);
      });
    this.pending.set(key, run);
    this.queue = run.catch(() => undefined);
    return run;
  }
}
