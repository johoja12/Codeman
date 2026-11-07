# Live Activity implementation (#171)

[Desktop](desktop.png) · [Mobile](mobile.png) · [Actual outgoing payload](payload.json)

These browser renders use the actual tested native UI payload, with sample session events. They approximate Discord rendering; Discord owns final styling. The approved design is tracked in #168. The default published card contains 35 of 40 allowed components, including the existing durable ownership marker. The existing dashboard message is migrated in place and pinned where permitted.

Recent remains the shared default. Filter, pagination, Refresh and Review interactions open private views. Finished uses native proof and a one-hour window. Event times and bounded assistant excerpts survive restarts in the existing private UI store; prompt bodies are omitted. Cosmetic updates never advance recency.

Validation: 326 targeted tests passed across native UI/services, activity projection, native execution, bridge/interface, delivery and history. Eight focused tests also passed against the compiled deployment artifacts. Playwright rendered the actual payload at 1440×1280 and 390×844, checking Recent, five rows, action visibility, component budget, no page errors and no horizontal overflow.

Research/design references: [Tickets Premium panels](https://www.tickets.tools/docs/ticketing/multi-panels/), [BotGhost V2 builder](https://botghost.com/whats-new/builder-update), [Discord component reference](https://docs.discord.com/developers/components/reference). Emoji graphics: [Twemoji](https://github.com/jdecked/twemoji), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); see emoji/LICENSE-GRAPHICS.
