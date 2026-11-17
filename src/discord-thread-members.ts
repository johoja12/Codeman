/** Idempotent membership for configured users in verified live session threads. */
export class DiscordThreadMembers {
  private due = new Map<string, number>();
  private pending = new Map<string, Promise<void>>();
  constructor(
    private readonly host: {
      scope(): string | undefined;
      users(): readonly string[];
      current(session: string, thread: string): boolean;
      verify(session: string, thread: string): Promise<boolean>;
      add(thread: string, user: string, current: () => boolean): Promise<unknown>;
      now(): number;
    }
  ) {}
  ensure(session: string, thread: string): Promise<void> {
    const scope = this.host.scope();
    if (!scope || !this.host.current(session, thread)) return Promise.resolve();
    const key = JSON.stringify([scope, session, thread]);
    const run = this.pending.get(key);
    if (run) return run;
    const current = () => this.host.scope() === scope && this.host.current(session, thread);
    const job = (async () => {
      const users = [...new Set(this.host.users())].filter((user) => /^\d{15,25}$/.test(user));
      const missing = users.filter((user) => (this.due.get(key + ':' + user) ?? 0) <= this.host.now());
      if (!missing.length || !current()) return;
      if (this.due.size >= 2048) this.due.clear();
      for (const user of missing) this.due.set(key + ':' + user, this.host.now() + 30_000);
      if (!(await this.host.verify(session, thread))) return;
      for (const user of missing) {
        if (!current() || !this.host.users().includes(user)) return;
        const valid = () => current() && this.host.users().includes(user);
        if (this.due.size >= 2048) this.due.clear();
        try {
          await this.host.add(thread, user, valid);
          if (valid()) this.due.set(key + ':' + user, this.host.now() + 300_000);
        } catch {
          // Retry membership independently; never recreate a thread or resubmit a task.
          if (valid()) this.due.set(key + ':' + user, this.host.now() + 30_000);
        }
      }
    })().finally(() => {
      if (this.pending.get(key) === job) this.pending.delete(key);
    });
    this.pending.set(key, job);
    return job;
  }
}
