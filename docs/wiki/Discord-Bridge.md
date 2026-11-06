# Discord Bridge

Answer a blocked agent from your phone, from anywhere. Codeman posts to a private Discord
server when a session needs you, gives every tab its own thread, and types your reply in that
thread into that tab. It only makes outbound connections, so nothing is exposed to the internet
and it works when you are away from your network.

**Opt-in, off by default. One server, one channel, threads per tab.**

> **Treat the Discord account like a login to the machine.** A reply from an allowed account is
> typed into agents that can run shell commands. Turn on 2FA and use a strong, unique password.

## What it does

- **Alerts** for permission prompts, questions, idle sessions, errors and a stopped crash loop. A
  question or permission prompt shows what is on the tab's screen right now, so you can see what is
  being asked; a finished turn or an error carries the CLI's whole last message.
- **One thread per tab** in a parent channel, so a reply always reaches exactly one session.
- **Replies** from an allowed user are typed into that tab as one line plus Enter (a single digit answering a waiting permission or question goes as the key alone, without Enter).
- **Files** you attach are saved in the tab's folder and the agent is given the path. An agent can
  send a file back.
- **Agents can ask for you.** `codeman notify "Press the reset button on the case" --urgent`
  posts to the tab's thread. Sessions from the installer or an npm install have the command (a git checkout run without the installer does not); see [below](#telling-the-agents).

## Set it up

The full least-privilege walkthrough (private server, bot, the exact permissions, IDs, token
handling) is in [docs/discord-bridge.md](https://github.com/Ark0N/Codeman/blob/master/docs/discord-bridge.md).
In short:

1. Make a private Discord server with one text channel, and copy the server, channel and your user IDs.
2. Create an application with a bot. Turn **Public Bot** off, turn **Message Content Intent** on, and
   invite it with the `bot` scope and only the permissions the guide lists (no Administrator).
3. In **App Settings → Notifications → Discord**, paste the bot token and the three IDs, press **Save**,
   then **Send test**, then turn **Talk to your sessions from Discord** on and **Save** again.

The token is a secret: it is kept in its own file (`~/.codeman/discord.json`, readable by its owner
only), never in the shared settings, and never shown again once saved.

## Options

| Option                       | Choices                                     | Default         |
| ---------------------------- | ------------------------------------------- | --------------- |
| Create threads               | On the first alert, or for every new tab    | First alert     |
| When a tab is deleted        | Keep, archive or delete the thread          | Archive         |
| Stale threads                | Keep, archive or delete threads no tab uses | Keep            |
| @ ping                       | Never, critical events only, every post     | Critical only   |
| Which events                 | Needs attention, or everything              | Needs attention |
| Tell Claude how to reach you | On or off                                   | On              |

A finished turn, and an error, is posted as the CLI's whole last message, with its formatting and questions
kept, split over several posts if it is long. A shell, and permission or question dialogs, show the last lines
of the screen instead.

Only some CLIs raise a turn end. Claude Code does (an idle alert by default, and a stop alert when **Which
events** is Everything), and DeepSeek Harness sends a stop. The others (Codex, OMP, OpenCode, Gemini,
Antigravity, Pi, Grok, Copilot) send none, so their messages reach Discord with an error or `codeman notify`;
Codex's dialogs are read off its screen.

The stale-thread setting also archives or deletes threads that **When a tab is deleted** kept or archived, because a
deleted tab's thread leaves the bridge's map.

Deleting a thread needs the **Manage Threads** permission on the channel. "Critical" means a
permission prompt, a question, an error, or a post an agent marked urgent.

## Telling the agents

An agent only posts deliberately if it knows it can:

- **Claude** is launched with the instruction as part of its system prompt (**Tell Claude how to reach you**, on by default), so nothing shows in the chat. This reaches local tabs only (remote and Docker tabs have no `codeman` command).
- **Every other CLI** is not told. It can still run `codeman notify` if you tell it to.

Tabs that were already open when you turned the bridge on are not told. The alerts still reach
Discord for them; only the agent-initiated `codeman notify` habit is missing.

## Files

- **You to the agent:** attach a file to a reply. It is saved as
  `<tab folder>/.codeman-discord/<message id>-<name>` and the line the agent sees ends with
  `[attached: <path>]`. At most 5 files of 8 MB each. The folder ignores itself, so nothing in it is committed.
- **Agent to you:** `codeman notify "message" --file <path>` uploads a file of at most 8 MB that lies
  inside the tab's folder. Credential files such as `.env` are refused.
- Remote (ssh) tabs have no local folder, so they neither send nor receive files.
- A file you send is untrusted content to the agent that opens it.

## Safety

- Only user IDs on the allowlist, in your server, inside a thread Codeman made, are acted on.
  Everything else is dropped.
- A reply is cut to one printable line (1000 characters) and limited to one per second per tab.
- Posts can ping only the allowlisted users, so agent output cannot ping the whole server.
- A Discord outage or a bad token never affects a session; it backs off, and the last error shows in Settings.

## Troubleshooting

| Symptom                                          | Check                                                          |
| ------------------------------------------------ | -------------------------------------------------------------- |
| Send test says 401                               | The token is wrong or was reset. Paste the current one.        |
| Send test says the bot cannot see it             | Check the bot's role and the channel ID.                       |
| Posts arrive but replies do nothing              | Message Content Intent is off, or your user ID is not allowed. |
| Status line says "Message Content Intent is off" | Turn it on in the Developer Portal, Bot tab.                   |
| A thread is not deleted                          | The bot lacks Manage Threads on the channel.                   |

See also: [Notifications And Approvals](Notifications-And-Approvals) for the other ways to hear
from an agent, and [Security](Security) for how secrets are handled.

### Start a new session from a case channel

In **Full mode**, use `/claude`, `/codex`, `/opencode`, `/shell`, or another enabled CLI's slash command in a Codeman case channel. Review the case, execution host and default group, then press **Confirm** within one minute. Codeman creates a new session and posts its separate thread link. Open that thread to send the first prompt. No prompt is submitted during launch.

The commands also work inside an existing session thread and create a sibling session for the same configured case. They do not change the current thread's agent. Registration happens automatically in the configured Discord server; the bot needs application-command authorization. Unrelated commands are preserved. Disabled commands and commands used outside owned case destinations cannot launch sessions.

Local and linked SSH cases use the same creation service as the web UI and inherit the case's default session group. Unlinked workspaces, ambiguous aliases/names, unavailable cases and Docker cases must be launched through the web UI; Codeman never guesses a replacement host or directory. Existing sessions are left running.

## Native controls in Full mode

Use `/codeman` for the workspace dashboard, or the pinned session card for **Settings**, **History**, **Question**, **Queue**, **Results & files** and **Interrupt**. `!codeman ui` reopens controls when a menu expires. Working / Needs input / Idle filters and a case/host/CLI picker help you find or create the correct session.

New prompts receive visible delivery receipts. Received, input delivered, native submitted, working and finished are distinct; an unconfirmed prompt is never replayed automatically. While an agent works, choose **Send now**, **Queue next** or **Cancel**. Queued prompts can be edited/removed and wait for a verified empty input boundary. Questions and terminal drafts pause the queue. Ten prompts per session, fifty total; automatic dispatch expires after 24 hours. Queue text is stored privately until delivered or removed.

Model/effort menus change the current supported Claude/Codex conversation through verified native controls. Future Codex defaults are edited separately. Changing an approval launch flag never silently restarts a running session. Questions use exact prompt-bound choice menus or supported idle-response forms; dialogs Codeman cannot verify must still be answered in the terminal.

Results show observed native execution and provide guarded local/SSH file downloads, diff snapshots and execution receipts. A shared-workspace snapshot is not claimed as this task's changes, and tests/merge/deployment are not inferred from conversational text.

A message's **Apps** menu offers **Codeman: Send to session**, **Codeman: Queue follow-up** and **Codeman: Start session**. Review the explicit destination, source text and attachments before confirming. Creating a session and submitting the selected source are separate choices. All controls use the configured allowlist and private destinations; Notifications mode retains its existing behavior.
