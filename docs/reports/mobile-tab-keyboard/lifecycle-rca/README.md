# Follow-up RCA: native keyboard still fails (#35)

Status: candidate only; not a verified native-phone fix. Production is unchanged
from PR #36. Upstream PR #746 is draft pending this investigation.

## Confirmed gaps in the first fix

The shell-only checks proved DOM focus but did not prove the software keyboard
opened. They omitted non-terminal views, selection guards, input mode and user
interaction during a slow load.

The full-page matrix used three isolated instances: original baseline c0347106,
deployed fix 57e7c5cd, and a candidate derived from the deployed fix. Each instance
used two disposable shell sessions on separate data directories/tmux sockets. The
candidate source stayed unchanged during its frozen smoke run.

1. **Webview return:** the deployed version's first focus targets a hidden
   (`display:none`) terminal. That focus is rejected. Focus only succeeds after
   the network await, outside the original synchronous gesture path.
2. **Selection guard:** a lingering touch-selection guard blurs both deployed
   focus attempts; document focus ends on body rather than terminal input.
3. **Regression introduced by the first fix:** with keyboard-hidden selection
   now requesting focus, the post-load mobile refocus can steal focus from another
   input the user intentionally tapped while the session was loading. The old
   baseline leaves that input alone.

The candidate reveals the terminal and configures its input mode before focusing
synchronously, retires the previous selection/guard only on an explicit tab pick,
uses the existing mobile focus helper, and avoids late mobile refocus. Automatic
restore stays passive with the keyboard hidden. Desktop's late focus is unchanged.

## Verification and limits

- Full configured mobile keyboard/tab suites: deployed **76 passed, 12 failed**;
  baseline **75 passed, 13 failed** (88 cases each). All 12 deployed failures also
  occur on the baseline. The additional baseline failure is the old touch-focus
  test's stale `preserveKeyboard` expectation. These suites are not fully green.
- Candidate: **172 related tests and 9 focused browser checks passed**; typecheck,
  lint, formatting, lockfile and frontend syntax checks passed.
- Seven candidate full-page Chromium matrix assertions passed: hidden keyboard,
  same tab, webview return, CJK input, selection guard, stale helper coordinates,
  and deliberate focus elsewhere during a delayed load. No page errors.
- `chromium-matrix.json` includes raw baseline/deployed/candidate focus observations.
  Focus state and first-attempt geometry are tested; native keyboard visibility is
  explicitly not claimed.
- WebKit binaries and temporary dependency libraries were prepared without changing
  system packages. The engine launched, but timed out creating a page. Therefore
  no WebKit browser matrix passed and no iOS keyboard behavior has been verified.
- Claude authentication reports not logged in. Codex/shell smoke was run separately;
  this does not establish live Claude coverage or remote-host keyboard behavior.

Raw run logs are retained under `/tmp/codeman-35-*`. The GitHub issue records final
smoke outcomes and the candidate commit. A phone/browser identification and a
real-device reproduction are still needed before declaring the keyboard fixed.

## Fresh frozen smoke comparison

The before-fix baseline smoke passed **86**, failed **0**, skipped **1**. The
frozen deployed version and candidate each passed **84**, failed **2**, skipped
**1**. Their failing assertions are long-scrollback wheel navigation (return to
late history and reveal text before a divider). Historical baseline runs also
showed these failures, but the fresh baseline was green. Their cause is therefore
not established by this comparison; they must not be dismissed as unrelated.
The broader smoke gate remains red and the candidate is not deployed.
