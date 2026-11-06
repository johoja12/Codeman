# Discord native UI validation

The screenshots below render a real session-card component payload from `test/discord-native-ui.test.ts` with deterministic sample data. They are review previews, **not screenshots of the Discord client**. Discord owns final native component layout and platform styling.

- [Desktop component preview](desktop.png)
- [Mobile component preview](mobile.png)

Validation before deployment:

- 515 Discord/API/native-session regression tests passed. Reproduce with `npm test -- test/discord test/routes/discord test/native-model-settings-session.test.ts test/routes/session-routes-codex-defaults.test.ts`.
- Typecheck, lint, formatting and lockfile checks passed, including clean pre-push checks on the final implementation.
- Full isolated build passed; final backend modules were compiled and compared against the exact production baseline before staging. Unchanged frontend assets are preserved.
- Real isolated Codex sessions completed direct and input-revision-bound queued prompts with native completion events, inspected eight supported model choices and the reported effort, and blocked a foreign input revision. Future-default writes were verified independently of the running process. HTTP curl confirmed the temporary sessions; sessions were deleted afterward.
- Final candidate and unchanged integration baseline each passed all 86 realistic Codex/shell browser smoke checks, with no page/console errors. An initial candidate run had four long-scrollback assertions that did not reproduce. Live Claude authentication was not exercised; provider and local/SSH safety paths have targeted regressions.
- A separate run of the exact compiled production candidate repeated the native Codex, settings, defaults, HTTP and foreign-revision checks successfully.

Live Discord registration, ownership, pin availability and component payloads are checked after deployment. No automated prompts are sent to existing user sessions. Unsupported native dialog answer types remain terminal-only, and shared-workspace diffs are explicitly not claimed as task-attributed changes.
