# Discord response width

Assistant response bodies now use ordinary message content instead of fixed-width embeds. Links remain clickable with previews suppressed, code fences survive multipart splitting, mention permissions remain restricted, and critical/warning headings keep a visible severity marker. Session control cards are unchanged. Existing Discord messages retain their original layout.

[Desktop preview](desktop.png) · [Mobile preview](mobile.png)

These are illustrative HTML layouts using the real formatter payload, not screenshots of the Discord client. Discord controls final client rendering. Playwright confirmed desktop space use, mobile wrapping, preserved code text and no page errors. All 430 Discord regression tests passed, along with typecheck, lint, format and lockfile checks. The isolated TypeScript build passed. Deployment updates the formatter runtime only to preserve concurrent bridge enhancements.
