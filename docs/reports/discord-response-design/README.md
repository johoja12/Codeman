# Native Discord response design

Implements the approved LAN response mockup with native Components V2: a compact color-accented header, wide top-level Markdown, retained code blocks, native separators and existing guarded actions. Explicit commentary updates one durable progress message. Show updates opens a private panel rather than an inline disclosure. Unknown-phase assistant text remains visible. Green turn completion needs exact native execution evidence; it does not assert that prose claims about tests or deployment are verified.

[Desktop preview](desktop.png) · [Mobile preview](mobile.png) · [Actual sample payload](payload.json)

Previews render real formatter and response-control output with deterministic sample data in an illustrative Discord-like layout. They are not Discord client screenshots; Discord owns final dimensions and styling. Browser checks cover four states at desktop/mobile sizes, wide text outside the container, green completion accent, code preservation, action previews and no horizontal overflow/page errors.

Validation: 448 Discord/registry tests passed before the final same-text commentary/final regression was added; the additional parser/interface regressions also pass. Typecheck, lint, format, lockfile and isolated compilation passed. Disposable real Codex sessions exercised final-phase detection, model inspection, independent future defaults, revision-bound queue input, rejected stale input and HTTP curl checks, including against the production candidate. Test sessions were removed. The candidate preserves concurrent deployed bridge changes, and the compiled coalescing/restart test passed. Historical/uncertain delivery boundaries remain intact; no old task is replayed to restyle it.
