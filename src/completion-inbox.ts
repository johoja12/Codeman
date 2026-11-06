/** Shared review state for exact native completions. No prompt/response bodies or credentials persist. */
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { DiscordHistory } from './discord-history.js';
const cursor = z.string().min(1).max(200);
const Entry = z
  .object({
    id: z.string().regex(/^[a-f0-9]{32}$/),
    session: z.string().min(1).max(100),
    conversation: cursor,
    userCursor: cursor,
    responseCursor: cursor.optional(),
    message: z
      .string()
      .regex(/^\d{15,25}$/)
      .optional(),
    guild: z.string().regex(/^\d{15,25}$/),
    channel: z.string().regex(/^\d{15,25}$/),
    name: z.string().max(120),
    completed: z.number().finite(),
    reviewed: z.number().finite().optional(),
    source: z.enum(['web', 'discord']).optional(),
  })
  .strict();
const Observed = z
  .object({ conversation: cursor, users: z.array(z.object({ cursor, state: z.string().max(30) }).strict()).max(40) })
  .strict();
const State = z
  .object({
    version: z.literal(1),
    entries: z.array(Entry).max(512),
    observed: z.record(z.string().max(100), Observed),
  })
  .strict();
export type CompletionEntry = z.infer<typeof Entry>;
export class CompletionInbox {
  private state: z.infer<typeof State> = { version: 1, entries: [], observed: {} };
  private loaded?: Promise<void>;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now
  ) {}
  private load(): Promise<void> {
    return (this.loaded ??= (async () => {
      try {
        const f = await fs.open(
          join(this.dir, 'completion-inbox.json'),
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        );
        try {
          const st = await f.stat();
          if (!st.isFile() || st.size > 2 * 1024 * 1024) throw new Error('Unsafe completion inbox');
          const b = Buffer.alloc(2 * 1024 * 1024 + 1);
          const { bytesRead } = await f.read(b, 0, b.length, 0);
          if (bytesRead === b.length) throw new Error('Completion inbox exceeds size bound');
          this.state = State.parse(JSON.parse(b.subarray(0, bytesRead).toString('utf8')));
          if (Object.keys(this.state.observed).length > 1024) throw new Error('Completion observation limit');
        } finally {
          await f.close();
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
          throw new Error('Completion inbox unavailable; review tracking paused');
      }
    })());
  }
  private mutate(run: (state: z.infer<typeof State>) => boolean): Promise<boolean> {
    const result = this.chain.then(async () => {
      await this.load();
      const next = structuredClone(this.state);
      if (!run(next)) return false;
      next.entries = next.entries
        .filter((e) => e.completed > this.now() - 30 * 86400000)
        .sort((a, b) => b.completed - a.completed)
        .slice(0, 512);
      await fs.mkdir(this.dir, { recursive: true });
      const path = join(this.dir, 'completion-inbox.json'),
        temp = path + '.' + randomUUID() + '.tmp';
      try {
        const f = await fs.open(temp, 'wx', 0o600);
        try {
          const bytes = JSON.stringify(next);
          if (Buffer.byteLength(bytes) > 2 * 1024 * 1024) throw new Error('Completion inbox capacity reached');
          await f.writeFile(bytes);
          await f.sync();
        } finally {
          await f.close();
        }
        await fs.rename(temp, path);
        this.state = next;
      } finally {
        await fs.unlink(temp).catch(() => undefined);
      }
      return true;
    });
    this.chain = result.catch(() => undefined);
    return result;
  }
  async list(): Promise<CompletionEntry[]> {
    await this.load();
    await this.chain;
    return structuredClone(this.state.entries.filter((e) => e.completed > this.now() - 30 * 86400000));
  }
  async observe(input: {
    session: string;
    name: string;
    guild: string;
    channel: string;
    history: DiscordHistory;
    messages?: Record<string, string>;
  }): Promise<boolean> {
    let added = false;
    await this.mutate((s) => {
      const h = input.history,
        executions = (h.executions ?? []).slice(-40),
        old = s.observed[input.session];
      if (h.partial && !executions.length) return false;
      const same = old?.conversation === h.conversationId;
      const known = new Map(same ? old.users.map((x) => [x.cursor, x.state]) : []);
      const lastKnown = executions.map((e) => known.has(e.userCursor)).lastIndexOf(true);
      let enriched = false;
      for (const [index, e] of executions.entries()) {
        const id = createHash('sha256')
          .update(JSON.stringify([input.session, h.conversationId, e.userCursor]))
          .digest('hex')
          .slice(0, 32);
        const existing = s.entries.find((x) => x.id === id);
        const start = h.turns.findIndex((t) => t.role === 'user' && t.cursor === e.userCursor);
        const after = start < 0 ? [] : h.turns.slice(start + 1);
        const end = after.findIndex((t) => t.role === 'user');
        const response = (end < 0 ? after : after.slice(0, end))
          .filter((t) => t.role === 'assistant' && t.phase !== 'commentary')
          .at(-1);
        if (existing) {
          const before = JSON.stringify(existing);
          existing.responseCursor = response?.cursor ?? existing.responseCursor;
          existing.message = (response && input.messages?.[response.cursor]) ?? existing.message;
          enriched ||= before !== JSON.stringify(existing);
          continue;
        }
        // First observation establishes a baseline. Missing/expired boundaries never manufacture old notifications.
        if (
          !same ||
          e.state !== 'completed' ||
          known.get(e.userCursor) === 'completed' ||
          (!known.has(e.userCursor) && (old?.users.length ?? 0) > 0 && (lastKnown < 0 || index <= lastKnown))
        )
          continue;
        const entry = Entry.parse({
          id,
          session: input.session,
          name: input.name.slice(0, 120),
          guild: input.guild,
          channel: input.channel,
          conversation: h.conversationId,
          userCursor: e.userCursor,
          responseCursor: response?.cursor,
          message: response && input.messages?.[response.cursor],
          completed: Math.max(this.now(), ...s.entries.map((e) => e.completed + 1)),
        });
        s.entries.push(entry);
        added = true;
      }
      if (!old && Object.keys(s.observed).length >= 1024) throw new Error('Completion observation limit');
      const observation = {
        conversation: h.conversationId,
        users: executions.map((e) => ({ cursor: e.userCursor, state: e.state })),
      };
      const changed = JSON.stringify(old) !== JSON.stringify(observation) || added || enriched;
      s.observed[input.session] = observation;
      return changed;
    });
    return added;
  }
  review(ids: string[], source: 'web' | 'discord'): Promise<boolean> {
    const selected = new Set(ids);
    return this.mutate((s) => {
      let changed = false;
      for (const e of s.entries)
        if (selected.has(e.id) && e.reviewed === undefined) {
          e.reviewed = this.now();
          e.source = source;
          changed = true;
        }
      return changed;
    });
  }
}
