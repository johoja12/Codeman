/** @fileoverview Optional runtime enrichments: the bridge also accepts an ordinary upstream Session. */
import type { Session } from './session.js';
import type { SessionActivityStatus } from './types/session.js';
export type DiscordSessionView = Session & {
  suppressNotifications?: boolean;
  activityProjection?: { activityStatus: SessionActivityStatus };
};
