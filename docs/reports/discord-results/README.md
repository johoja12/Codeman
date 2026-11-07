# Discord results redesign (#163)

[Mobile preview](mobile.png) · [Desktop preview](desktop.png)

These are Playwright-rendered previews of the actual tested component payload in `payload.json`, not screenshots of the Discord client. Discord owns final styling. The answer and named file buttons replace the previous technical menu; diagnostics remain under More. Automatic duplicate result cards are retired only after bot, destination and marker ownership checks.

Validation: 162 targeted Discord native UI, bridge, artifact, workspace and service tests passed. Coverage includes exact historical response selection after expiry/restart, guarded file reads, conversation changes during a download, complete long-answer export, conditional workspace controls, non-Git workspaces, and refusal to remove another author's card. Playwright checks desktop/mobile button visibility and horizontal overflow. No prompts were submitted to live sessions.
