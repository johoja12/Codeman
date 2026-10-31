# Mobile tab keyboard focus (#35)

Root cause: explicit touch selection shared a policy that only focused the terminal
when KeyboardHandler already considered the keyboard visible; reselecting the active
tab returned before focusing. The fork's tab sheet also scheduled search focus 180ms
after opening, without cancelling it when a session was selected. A quick selection
therefore focused the terminal and then the closed sheet's offscreen search input.

The fix focuses terminal input synchronously for explicit selections, including the
active tab, preserves passive app-driven restore when the keyboard is hidden, and
cancels/guards delayed search focus before closing the sheet and selecting a session.

Chromium phone-emulation checks used two isolated disposable shell sessions on a
unique data directory and tmux socket. Switching tabs and quick active-tab reselection
kept focus on xterm's textarea after the delay; the sheet closed and no page errors
occurred. Screenshots show that isolated UI. No production session input was used.
Headless Chromium validates DOM focus, not native iOS keyboard presentation. WebKit
was unavailable on this machine; real-device iOS verification remains necessary.

Six focused browser checks and 172 related tests passed. The broader smoke retained
the two previously recorded long-scrollback wheel failures; no new focus/browser
errors appeared. See the GitHub issue for build, deployment and CI gates.
