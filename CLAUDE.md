# pi-gateway

## What this is: the team's harness

pi-gateway is where a team's agent harness lives: what an agent knows and what it can do — sessions and the
sandbox, tools and MCP, skills and plugins, prompts, long-term memory, and the policies over them.
A client (a BFF such as Noah) owns the conversation with people: the chat, the screens, who talks to whom.
When a capability could live on either side, that is the test.

Decided 2026-11-20, not built yet — these count as requested, not speculative:
- One login path, OIDC, shared with the clients (a bundled Keycloak first; a corporate IdP by changing the issuer).
- A client states per request whose memory a run may open and with which access; pi enforces it.
- The team's wiki moves here next to each user's memory: its history, its schema and policy checks, and a
  draft → commit pair where a commit needs a person's token.

## Principle: nothing left to take away

A good product is not one with nothing left to add, but one with nothing left to take away.
This repo exists to shed weight; that is why it is built on pi.
If it grows heavy again, it has lost its reason to exist.

The principle decides how a harness capability is built — the smallest thing that does the job, nothing in
advance — not whether one the team needs belongs here.

## Rules

1. **Build only what was requested or what fixes a confirmed defect.** Never build something because it "might be needed later".
2. **No speculative alternatives.** Don't add modes, options, config knobs or fallbacks in advance. Once a choice is made, delete the alternatives.
3. **Look for deletions before additions.** When changing something, remove any code, config, docs or scripts that the change makes unnecessary.
4. **Keep verification proportional.** Run the existing checks (`npm run typecheck`, `npx vitest run`) and add only the tests the change needs. Extra harnesses, tooling, review rounds or agents only when asked.
5. **Keep explanations short.** Lead with the purpose. If more work seems worthwhile, propose it in one line; don't build it.
6. **Avoid new environment variables.** Hardcode a value if you can. If operators really must change it, put it in the admin panel instead. Use an environment variable only for what must be known at startup (addresses, secrets, resource sizes). Every new variable also goes into `.env.example` and `docker-compose.yml`, so prefer removing one to adding one.

## Keep the session prefix stable

The LLM server (vLLM) reuses its cache only for an unchanged prefix. A change near the head makes it recompute the whole conversation, so never change what a session has already sent to the model.

- The system prompt, skill list and tool declarations are fixed when the session is created. Don't put values that change per turn in them (time, request data, server or tool state).
- New information goes at the end, as a new message or a tool result. Never edit, reorder or drop earlier messages.
- Tools that come and go stay behind fixed declarations (MCP tools behind `mcp_search` and `mcp_call`).
- Changes that are meant to break the prefix: compaction, a model change, and admin or plugin changes picked up when a session is reopened.

## When a request conflicts with the principle

This includes requests from the user. If a request seems to violate the rules above, don't build it right away:

1. Say why it conflicts, in one or two sentences.
2. Propose a smaller option. Doing nothing counts.
3. Get confirmation.

Proceed only if the user still wants it.

Fixes needed to uphold the security requirements count as confirmed defects:
- OS-level isolation of everything outside the user's workspace;
- MCP credentials never exposed to the agent.

The one sanctioned exception: a service-key request's `sandbox_env` (the BFF handing its own user's
secrets to that user's shell). It reaches only that turn's `bash` exec env, lives only in the live
session's memory (never the DB, session JSONL, logs or admin UI), and every tool result, progress
update and error is redacted of its values before the model, the client or the transcript sees it.
Never widen it (other tools, sandbox MCP servers, user-key requests, persistence).
