# Dismiss/reopen coverage correction (#35)

The reporter clarifies that opening initially works, then closing the keyboard makes reopening unreliable. Latest v6 phone traces still contain failed opens after gesture release, plus successful owned dismiss/reopen flows; native reliability is not established.

Two additional source defects are reproduced before the correction:

- A prompt tap while the keyboard is already open and its input remains focused advanced the opening generation. This unnecessarily invalidated the shown keyboard's owner; a later native dismissal could leave editing focus retained. Merely retaining the same open input now keeps its generation. A real open or transfer to another input still supersedes the prior request before focus callbacks. Diagnostic attempt IDs remain separate from ownership.
- SSE initialization explicitly cleans up and reinstalls KeyboardHandler listeners. Reinitialization while the keyboard was open adopted the shrunken visual height as the keyboard-free baseline. Same-width listener reconnection now retains the calibrated baseline and current ownership, allowing the subsequent dismissal and reopen to classify correctly.

The new unit cases and repeated prompt-tap browser cycle failed on v6. Final checks: 217 related unit tests, 18 browser regressions, full 56-test mobile keyboard suite, static checks and build pass. The browser cycle includes 20 open/dismiss/reopen sequences with zero/one/two actual prompt touch gestures while open, plus reconnect while open followed by dismissal/reopen. Previous 25 delayed-close and newer-focus protections remain covered. A full-page disposable real shell passed 30 mixed dismiss/late-close cycles, each with two actual prompt taps while open and a verified executed command. No page errors. Realistic smoke passed 86 checks, zero failures, one unconfigured external-remote skip.

The last hide decision (owner, current generation, input identity match and release result) is retained in future breadcrumbs, so repeated failed taps cannot erase why the preceding close did or did not release focus. No input contents are logged.

The latest phone trace does not retain every original open/close event, so the two reproduced defects are not claimed as the complete explanation for every native refusal. Native keyboard presentation still requires the reporter's actual phone check. Issue #35 stays open and PR #37 draft.
