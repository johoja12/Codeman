# Upstream scrolling comparison

Local branch: `test/upstream-scrolling`, based on merged fork `master` (`ef1485af`).
Reference: [Ark0N/Codeman](https://github.com/Ark0N/Codeman), `a8a8bb71`.
Tracked in [fork issue #3](https://github.com/johoja12/Codeman/issues/3).

This branch copies upstream's main wheel listener and uses its existing shared
transcript paging rules. Codex and OpenCode use local scrollback or PageUp/PageDown;
Claude forwards SGR wheel reports only with the upstream version/tracking gates.
Fork wheel pacing is disconnected from wheel, touch and momentum input. Live Mirror
is disabled regardless of saved browser settings, so scrolling cannot open the
fork's frozen History view. The Live Mirror setting is disabled in the UI.

Other fork features remain, including remote capture, session recovery, resize
handling and OpenCode click support. This is a scrolling comparison, not a complete
replacement of the fork by upstream. Dormant mirror/pacing helpers remain for an
easy comparison or reversal.

To run separately from production in this worktree:

```bash
CODEMAN_INSTANCE=upstream-scroll-test CODEMAN_PORT=5307 npm run dev
```

Use an unused port and create disposable sessions in that instance. Its separate
instance name keeps its data directory and tmux socket separate from production.
This branch has not been pushed or deployed.

Validation: 179 targeted tests passed, one existing test skipped. Browser checks
covered Codex/OpenCode PageUp routing, Claude SGR routing, shell scrollback, mobile
geometry and resistance to saved Live Mirror settings. The agent routing checks
used controlled terminal fixtures, not end-to-end real CLI transcript navigation.
Typecheck, lint and frontend syntax checks passed.
