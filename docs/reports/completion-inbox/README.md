# Shared completion inbox validation

[Desktop](desktop.png) · [Mobile](mobile.png)

Screenshots exercise the real new web UI module and stylesheet against deterministic inbox fixtures. Browser checks cover a completion arriving while an older answer opens, hidden pages, loading/scrolled terminals, modal overlays, exact visible-answer matching and Discord-side read state updating the web count. These are web UI fixture screenshots, not Discord client screenshots.

507 targeted regressions passed, plus final inbox-card/API tests after scope refinements. Browser fixture checks passed 24 assertions. The realistic temporary Codex/shell smoke passed all checks with no page or serious console errors, and removed its temporary sessions. The first smoke run found a missing ignored predictive-echo bundle in the isolated worktree; running the existing postinstall asset generation resolved it. No terminal implementation was changed. Live Claude auth and external SSH smoke were not exercised.

Read detection is intentionally conservative. Discord passive reads cannot be observed by a bot. Web terminal acknowledgement requires a visible exact-answer anchor; short/ambiguous answers use Open response or Mark read. Review state is shared, durable, exact-completion scoped and independent of approval state.
