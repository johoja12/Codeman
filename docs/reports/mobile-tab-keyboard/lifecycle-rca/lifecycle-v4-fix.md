# Keyboard lifecycle correction (#35)

The previous blur-on-hide follow-up is removed. Passive viewport hide processing now updates layout without blurring input, so a closing resize from an earlier dismiss cannot cancel a newer reopen. Explicit dismiss, foreground stale-input release, and deliberate gesture focus retain their own responsibilities.

`forceKeyboardHidden()` no longer recalibrates the keyboard-free height from the current visual viewport. A focus-out fallback or foreground event can occur while that viewport is still shrunken; preserving the stable baseline allows a new open at the same smaller height to be detected. Actual restored viewport and display-shape events continue to update calibration normally.

Content-free v4 diagnostics record browser/build identity, focus/blur and viewport transitions, and observations 350/1000 ms after a focus request. Observation callbacks never focus, blur, or type, and superseded requests stop logging delayed observations. No prompt or typed text is recorded.

Validation:

- Six new regression cases failed on the prior code, then passed: reopen at 0/80/200/349 ms before the old close resize, foreground recovery before restoration, and focus-out fallback before restoration.
- 211 related unit tests passed, including the OpenCode mobile font test that failed in the preceding PR revision.
- 14 browser regressions passed, including 25 real browser gesture cycles with overlapping close/reopen, the actual foreground listener, delayed observation preserving another editor, selection guard, hidden webview return, and no delayed focus stealing after slow session loads.
- Full mobile keyboard suite: 56 passed.
- Separate full-page disposable shell probe: 30 rapid reopen cycles using actual touch taps, 30 commands delivered and executed, zero browser page errors. The marker was produced by printf formatting, rather than matching echoed command text. The session and isolated server were cleaned up.
- Typecheck, lint, formatting, lockfile, frontend syntax and isolated build passed.

The full unit/integration sweep and fresh realistic smoke results are recorded in issue #35 / PR #37 after completion. The smoke runner was corrected to use the requested wheel direction in its fallback and to permit enough steps to traverse the retained 10,000-line replay; the prior 120-step limit stopped partway through valid scrolling. The assertions remain intact. First corrected run passed the replay checks but failed a live repaint check; a fresh rerun is required before calling the broad gate green.

A real phone OS keyboard is not simulated by Chromium or visualViewport mocks. These tests establish the corrected event ordering, focus preservation, state classification and delivered input, not native keyboard presentation. Actual phone confirmation remains necessary before closing #35.

Temporary evidence: `/tmp/codeman-35-lifecycle-red.log`, `/tmp/codeman-35-lifecycle-green.log`, `/tmp/codeman-35-lifecycle-v4-browser.log`, `/tmp/codeman-35-v4-mobile.log`, `/tmp/codeman-35-v4-delivery.json`.
