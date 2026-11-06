# Shared completion inbox validation

[Desktop](desktop.png) · [Mobile](mobile.png)

Screenshots exercise the real new web UI module and stylesheet against deterministic inbox fixtures. Browser checks cover a completion arriving while an older answer opens, hidden pages, loading/scrolled terminals, modal overlays, exact visible-answer matching and Discord-side read state updating the web count. These are web UI fixture screenshots, not Discord client screenshots.

Final combined unit/regression sweep passed 537 tests. Browser fixture checks passed 24 assertions. A disposable full Codeman instance with a real shell and deterministic native-history fixtures passed curl, exact-response viewing, visible-terminal read detection and persisted acknowledgement, with no browser errors. Test sessions were removed.

Realistic smoke limitations: the unchanged baseline passed; candidate runs passed Codex and shell functional cases but had intermittent terminal replay/divider assertions, including with inbox assets gated off. Terminal source and vendor hashes are unchanged. All runs had cleanup, and the asset-complete runs had no browser page/serious console errors. The initial run also found a missing ignored predictive-echo bundle in the isolated worktree; existing postinstall generation resolved that asset error. No terminal implementation was changed. External SSH and live Claude auth were not exercised.


Read detection is intentionally conservative. Discord passive reads cannot be observed by a bot. Web terminal acknowledgement requires a visible exact-answer anchor; short/ambiguous answers use Open response or Mark read. Review state is shared, durable, exact-completion scoped and independent of approval state.
