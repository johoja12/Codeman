# Repeated keyboard dismiss and reopen (#35)

The previous repair refocused a retained terminal textarea inside one tap. Phone breadcrumbs still showed trusted, focused input with a keyboard-free viewport after repeated attempts. A native keyboard dismiss does not necessarily blur the textarea.

The hide transition now blurs only terminal-owned input. The next deliberate tap starts from an unfocused input, instead of depending on a blur/focus pair within that tap. An unrelated editor retains focus. No timer refocus or keyboard-opening retry runs in the background.

Validation: Chromium regression exercises 25 show/dismiss/reopen cycles through the actual viewport detector and hide handler. A separate full-page isolated session exercises 12 cycles (36 states), with no input outside the visual viewport and no focus-state mismatch. These are focus and viewport simulations, not native OS keyboard verification. Native phone confirmation remains required; issue #35 and PR #37 stay open.
