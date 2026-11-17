/** @fileoverview Optional runtime enrichments: the bridge also accepts an ordinary upstream Session. */
import type { Session } from './session.js';
import type { SessionActivityStatus } from './types/session.js';
export type DiscordSessionView = Session & {
  readonly codexConfig?: import('./types/session.js').CodexConfig & { baseCommand?: string };
  /** Optional host capability: exact native resume with no fresh-conversation fallback. */
  resumeExitedRemote?(current: () => boolean): Promise<boolean>;
  suppressNotifications?: boolean;
  activityProjection?: { activityStatus: SessionActivityStatus };
};
