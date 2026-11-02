# Header-menu workaround persists after v4 (#35)

The reporter still needs to tap the header menu before the keyboard can open. Fresh production breadcrumbs confirm the current v4 build on iPhone Chrome (CriOS/156, iPhone OS 27.2 UA), not only an older cached page.

In the latest retained phone trace, request 18 obtains terminal focus from a trusted gesture at height/baseline 763. The input remains focused with a keyboard-free viewport after both 350 ms and 1000 ms. No delayed blur or bad baseline appears in that attempt. A later request 19 is followed by a visual viewport shrink to 449 after about 120 ms. The reporter associates the successful retry with the menu tap; v4 did not record menu events, so its exact menu timestamp cannot be inferred from those logs alone.

The menu changes header classes and app padding, dispatches window resize, and participates in native focus transfer. Existing evidence does not distinguish layout/clip repair from browser editing-session behavior. The two v4 lifecycle corrections remain valid, but do not explain this remaining native refusal.

This follow-up adds diagnostic observations only: input rectangle, intersection with the visual viewport and clipping ancestors, active element type, readonly/disabled/input mode, app height, and header menu state. Menu open/close and settled state are explicitly traced. No typed input/value is logged, and no diagnostic changes focus or retries keyboard opening. A browser regression checks clipping detection and verifies private textarea contents are excluded and another editor keeps focus.

This is not described as a fix for the remaining menu workaround. After deploying this diagnostic candidate, a failed terminal tap followed by menu open/close and another terminal tap is needed on the actual phone. Chromium/viewport simulations cannot establish the native keyboard result.
