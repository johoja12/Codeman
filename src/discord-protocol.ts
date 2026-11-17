/** Shared Discord wire and control types; contains no runtime bridge behavior. */
export interface DiscordFile {
  name: string;
  data: Uint8Array;
}
export interface DiscordControlReply {
  questionCard?: boolean;
  verifiedSettings?: { model: string; effort?: string };
  text: string;
  locateSessionId?: string;
  file?: DiscordFile;
  actions?: Array<{ label: string; command: string; validity: string; style?: number }>;
}
export interface DiscordInteraction {
  id: string;
  application_id: string;
  token: string;
  guild_id?: string;
  channel_id?: string;
  type: number;
  data?: {
    custom_id?: string;
    id?: string;
    name?: string;
    options?: unknown[];
    values?: string[];
    target_id?: string;
    resolved?: { messages?: Record<string, GatewayMessage> };
    components?: Array<{ components?: Array<{ custom_id?: string; value?: string }> }>;
  };
  member?: { user?: { id: string } };
  user?: { id: string };
  message?: { id: string; flags?: number };
}
export interface DiscordPost {
  /** Internal upload envelope, removed before JSON encoding. */
  files?: DiscordFile[];
  content: string;
  flags?: number;
  allowed_mentions: { parse: string[]; users: string[] };
  nonce?: string;
  enforce_nonce?: boolean;
  embeds?: Array<{ title?: string; description: string; color: number; footer?: { text: string } }>;
  components?: Array<{
    type: number;
    content?: string;
    accent_color?: number;
    divider?: boolean;
    spacing?: number;
    file?: { url: string };
    components?: Array<Record<string, unknown>>;
  }>;
}
export interface GatewayMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  content: string;
  author: { id: string; bot?: boolean };
  attachments?: Array<{ id: string; filename: string; size: number; url: string }>;
}
