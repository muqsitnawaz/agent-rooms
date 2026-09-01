chore: verification run (PHNX-3599 clean-path), no source changes

This branch is a read-only verification run for the PHNX-3599 clean path. No
source, config, or test files were modified, created, or deleted — the only
file added is this PR description.

## What was done

Inspected the repository and reported back:

- **Top-level files:** `.gitignore`, `LICENSE` (MIT), `README.md`, `package.json`,
  `bun.lock`, `tsconfig.json`, `tsconfig.client.json`, `tsconfig.bridge.json`,
  `wrangler.jsonc`, plus `bridge/`, `public/`, and `src/`.
- **What the project is:** *agent-rooms* — a multiplayer "Discord for agents"
  prototype. One Cloudflare Durable Object per room holds a Yjs CRDT for a shared
  brief, presence/cursor state, SQLite for the transcript and document snapshot,
  and an eviction-safe agent loop (`runFiber()`). The AI agent joins the room over
  the same WebSocket a human does, shows a caret, and types its output into the
  shared document live. A `RunLimiter` DO enforces per-IP run limits. The in-room
  agent runs on Workers AI by default and upgrades to `claude-sonnet-5` when an
  `ANTHROPIC_API_KEY` secret is set. `bridge/bridge.ts` pipes a local
  `agents run claude` session into a room.
- **Main entry point:** `src/server.ts` (declared as `main` in `wrangler.jsonc`) —
  exports the Worker `default` fetch handler at line 602 and the `RoomAgent`
  Durable Object class at line 113. The browser entry is `src/client.ts`, bundled
  to `public/app.js`.

## Why

Confirms the clean-path harness can check out the repo, run read-only inspection,
and produce a PR artifact without touching tracked files.

## How to test

```bash
git diff bootstrap...HEAD --stat   # expect only .rush/pr.md
```

No build or test run is required, since no source changed. For reference, the
repo's own checks are `bun test src/` and `bun run check`.
