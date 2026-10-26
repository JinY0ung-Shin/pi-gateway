# pi-gateway

## Principle: nothing left to take away

A good product is not one with nothing left to add, but one with nothing left to take away.
This repo exists to shed weight; that is why it is built on pi.
If it grows heavy again, it has lost its reason to exist.

## Rules

1. **Build only what was requested or what fixes a confirmed defect.** Never build something because it "might be needed later".
2. **No speculative alternatives.** Don't add modes, options, config knobs or fallbacks in advance. Once a choice is made, delete the alternatives.
3. **Look for deletions before additions.** When changing something, remove any code, config, docs or scripts that the change makes unnecessary.
4. **Keep verification proportional.** Run the existing checks (`npm run typecheck`, `npx vitest run`) and add only the tests the change needs. Extra harnesses, tooling, review rounds or agents only when asked.
5. **Keep explanations short.** Lead with the purpose. If more work seems worthwhile, propose it in one line; don't build it.

## When a request conflicts with the principle

This includes requests from the user. If a request seems to violate the rules above, don't build it right away:

1. Say why it conflicts, in one or two sentences.
2. Propose a smaller option. Doing nothing counts.
3. Get confirmation.

Proceed only if the user still wants it.

Fixes needed to uphold the security requirements count as confirmed defects:
- OS-level isolation of everything outside the user's workspace;
- MCP credentials never exposed to the agent.
