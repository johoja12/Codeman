# Mobile keyboard reliability: deeper RCA, 2026-11-01

Scope: analysis of deployed frontend candidate `2ded578a`, issue #35 / draft PR #37. No production source or behavior was changed during this investigation.

## Result

Two deterministic lifecycle defects are reproduced. The latest automatic blur-on-hide change can cancel a fresh reopen request during the preceding close animation. Separately, foreground recovery can replace the keyboard-free baseline with a still-shrunken visual viewport. Neither finding alone proves the cause of every native keyboard refusal reported on the phone.

## Fresh production evidence

The server serves `mobile-handlers.90de8d54.js` and `terminal-ui.f6f7b9f3.js`. The most recent retained phone page contains 12 KEYBOARD_FOCUS breadcrumbs: 11 show focused=true, gesture=true, cached=false, viewport=763, baseline=763; one shows viewport=449, baseline=449, minimum=0. This confirms that successful DOM focus and a recorded user activation did not establish keyboard visibility, and that keyboard-sized geometry can become the hidden baseline.

The page breadcrumbs do not identify the loaded asset hash, phone/browser, focus/blur source, or the subsequent viewport timeline. Server assets are verified; the particular phone page's build cannot be proven from this payload. A narrow CSS/screenshot inference cannot supply the missing device identity. No typed text was needed for this analysis.

## Reproduction A: old close cancels a new open

1. Keyboard is detected open: visual height 420, stable baseline 750, terminal focused.
2. User dismisses it, then refocuses the input before the close animation finishes.
3. The old closing resize reports height 750.
4. `handleViewportResize()` calls `onKeyboardHide()`.
5. The new unconditional terminal blur inside `onKeyboardHide()` clears the fresh focus.

The actual deployed handler in a VM reproduces focused=true -> focused=false, with one blur caused by the old close transition. This is a code-level race, not a native keyboard test. It was introduced by the latest follow-up. A resize describes geometry; it does not identify which focus request it belongs to.

## Reproduction B: foreground recovery corrupts calibration

1. Start with baseline 750, visual height 420, keyboard=true.
2. Return to the page before a closing viewport resize has arrived.
3. The visibility listener blurs terminal input and calls `forceKeyboardHidden()`.
4. That method sets baseline=420 and keyboard=false.
5. A subsequent focus/resize at height 420 computes no shrink; keyboard remains false.

The actual handler reproduces this transition. The phone's height=449/baseline=449/minimum=0 is consistent with it, but the existing breadcrumbs cannot prove that exact event ordering on the device. Initialization while already shrunken has the same calibration risk.

## Why previous checks missed it

The 25-cycle regression serializes open -> complete hide -> next focus. The full-page probe also supplies an idealized shrink/restore sequence. Neither tests reopening before the previous animation completes. Chromium emulation and mocked visualViewport height do not display an OS keyboard. Several unit descriptions incorrectly imply blur/focus guarantees WebKit keyboard opening; their assertions only check method calls.

The helper-position probe used a disposable shell and did not reproduce an offscreen field. That excludes only that fixture; it does not establish geometry for a real Codex/Claude screen on the phone.

Current GitHub CI is also not green: the unit/integration job reports `test/opencode-mobile-font.test.ts:910`, where the new hide-handler focus side effect reaches `_blurMobileTerminalInput` through an incomplete fixture. Static checks passed. This does not prove a native keyboard cause, but shows the coupling reaches beyond the targeted keyboard suite.

## Repair direction

- Separate focus intent from geometry. Keyboard-hide layout processing must not indiscriminately blur a newer open request. Explicit dismiss owns blur; passive resize owns layout. If focus release remains necessary for native dismissal, it needs a request generation and transition ownership check.
- Preserve keyboard-free calibration across background/foreground transitions. Mark visibility uncertain while geometry settles; do not overwrite the baseline with the current shrunken height merely because focus changed. Reconcile against observed restoration and appropriate layout-viewport evidence for the supported browser.
- Route explicit terminal/tab keyboard requests through one synchronous gesture path. Avoid timer-based reopen loops and late focus after network loads.
- Add content-free event tracing: build/browser identity, gesture source and request generation, focused input identity, blur reason, visibility, visual viewport height/width/offset/scale, layout height, and observations immediately / 100 / 350 / 700 ms after the request. Diagnostic timers may observe; they must not steal focus.
- Do not add a separate mobile composer or replace xterm input on the basis of these traces alone. First compare direct native textarea focus with routed xterm focus on the actual device.

## Acceptance matrix

Test rapid close/reopen before, during and after the closing resize; repeated same-tab taps; tab switching with slow remote loading; app background/foreground with delayed resize; existing keyboard on reload; header-menu detour; selection guards; CJK input; another editor focused during a late resize; native dismiss and accessory dismiss. Repeat at least 30 cycles on the reporter's real phone/browser. Assert the visible native keyboard and delivered input as well as DOM focus. Keep local/remote sessions and Claude/Codex separate from the browser-level keyboard result.

No new fix or deployment is claimed by this report. Issue #35 should remain open and PR #37 draft until native device validation.

## Primary references

- WebKit distinguishes programmatic DOM focus from software keyboard presentation, including embedding-client exceptions: https://bugs.webkit.org/show_bug.cgi?id=195884
- Chromium explains visual/layout viewport differences and keyboard resize behavior: https://developer.chrome.com/blog/viewport-resize-behavior

## Evidence

`keyboard-lifecycle-repro.json` contains both deterministic handler replays. Temporary runnable probe: `/tmp/codeman-35-deep-baseline.cjs`; it loads the actual handler through the existing test fixture. Raw production diagnostic snapshot: `/tmp/codeman-35-deep-diag.json` (kept outside git). These are code/state reproductions; nativeKeyboardVerified=false.
