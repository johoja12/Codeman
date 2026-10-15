# Terminal scrolling

The fork uses the scrolling implementation from
[Ark0N/Codeman](https://github.com/Ark0N/Codeman), reference `a8a8bb71`.
The adoption and cleanup are tracked in
[issue #3](https://github.com/johoja12/Codeman/issues/3).

- Normal terminal history scrolls locally. Native mouse-tracking and alternate
  screen applications retain the upstream passthrough rules.
- Claude forwards SGR wheel reports when its version is at least 2.1.187 and
  the CLI has enabled mouse tracking. Shift and the local-history preference
  retain the upstream fallback rules.
- A CLI with an empty local buffer can page its own transcript using
  PageUp/PageDown. The CLI registry's `transcriptPageKeys` capability controls
  this behavior for Claude, Codex and OpenCode. Dialog and gesture safeguards
  are shared by primary and tiled terminals.
- Touch movement and momentum use the same forward/page/local choice as wheel
  input. Each movement contributes its pixel distance once. The fork's touch
  contact tracking, selection cancellation and click support remain.

The previous fork-specific Live Mirror / frozen History mode and calibrated
wheel pacing have been removed, including their UI, state, constants and
calibration payloads. Saved `liveMirrorEnabled` browser settings no longer have
an effect; the legacy key is discarded before the strict settings API is called.
Remote history capture, output recovery, snapshots and viewer sizing remain.

## Testing alongside production

A frontend proxy can serve the branch's browser assets while forwarding HTTP,
SSE and terminal WebSockets to the existing production backend. This lets a test
UI access the same sessions without starting a second session manager or sharing
a writable state directory between server processes. Input and resize actions
through that UI affect the real sessions.

For independent disposable sessions, start a separate instance with an unused
port and unique instance name:

```bash
CODEMAN_INSTANCE=upstream-scroll-test CODEMAN_PORT=5308 npm run dev
```

Never point an independent second server at production's data directory or tmux
socket. The instance name separates both by default.
