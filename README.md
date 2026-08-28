# agent rooms

**Discord for agents.** Share a URL. Everyone who opens it edits the same brief with live
cursors — and the agent is in the room with you, with a cursor of its own, reading the line
it is working on and typing its work back into the document while you watch.

One Cloudflare Durable Object per room. No database, no socket server, no queue.

```
https://agent-rooms.<your-subdomain>.workers.dev/#/r/payments-refactor
```

![Two people editing one brief while the agent writes into it](https://share.agents-cli.sh/muqsitnawaz/tmp-agent-rooms-hero-1166c6b0465d74f0)

*Two humans (round avatars, blue and pink carets) and one agent (square, lime) in the same room. The agent's caret sits on the line it is reading; the Plan section appeared in the document as it wrote.*

## What it does

- **Live multiplayer editing.** A Yjs CRDT in the room object; every keystroke merges, nobody's
  edits get dropped. Named carets, per-person colours.
- **The agent is a participant, not a service.** It joins the same WebSocket a human does, shows
  up in the presence rail, parks a caret on the brief line it is reading, and appends its output
  into the shared document — visibly typing, in front of everyone.
- **Humans and agents are told apart at a glance.** People are round avatars; agents are square,
  monospaced and glowing. An agent's caret drags a spotlight across its line; everything it says
  in the feed carries a lime spine. You never have to read a name to know who did something.
- **Steer mid-run.** Anyone in the room can edit the brief or drop a line in the composer. The
  agent re-reads the brief on its next step, so a constraint added at second 4 lands in the work.
- **Rooms outlive everyone.** Brief and transcript live in the object's SQLite. Close every tab,
  come back tomorrow, it is all still there.
- **Runs survive eviction.** Durable Objects get evicted after ~70–140s idle; a run is wrapped in
  `runFiber()` with checkpoints, so an eviction mid-stream is recovered and reported instead of
  silently truncating.
- **Bring your own local agent.** The bridge pipes a real `agents run claude` on your laptop into
  the room, so a session that was private to one terminal becomes something a group can watch.

## Run it

```bash
bun install
bunx wrangler deploy
```

That is the whole setup. The in-room agent runs on **Workers AI**, so there is no API key to
configure — clone, deploy, and the room has a working agent. To run Claude instead:

```bash
bunx wrangler secret put ANTHROPIC_API_KEY
```

Nothing else changes; the same room upgrades to `claude-sonnet-5`.

Local development:

```bash
bun run dev            # wrangler dev on :8799, client bundled first
```

## Bridge your own coding agent into a room

```bash
bun run bridge --room payments-refactor \
  --host agent-rooms.<your-subdomain>.workers.dev \
  -- agents run claude "refactor the refund flow"
```

The bridge joins as `kind=agent`, translates the harness's ndjson (`agents run … --json`) into
room events, mirrors the shared brief to `.agent-rooms/brief.md` so the agent can re-read it, and
appends anything the room steers into `.agent-rooms/steers.md`.

> Note: Cloudflare's `agents` npm package installs a binary **also** called `agents`, which
> shadows [agents-cli](https://github.com/muqsitnawaz/agents-cli) on `bun run`'s PATH. The bridge
> strips `node_modules/.bin` from the child's PATH so `agents run claude` reaches the right CLI.

## How it works

```
browsers ─┐
          ├─ wss ──▶  RoomAgent (one Durable Object per room)
bridge  ──┘             ├── Y.Doc          the shared brief (CRDT merge + relay)
                        ├── presence       cursors, colours, human/agent kind
                        ├── SQLite         transcript + document snapshot
                        └── runFiber       the in-room agent loop, eviction-safe
```

Because a Durable Object is single-threaded and addressable by name, **the room and the agent's
memory are the same object** — there is no synchronisation problem between what the humans are
typing and what the agent is reading. That is the entire architecture, and it is why this is a
weekend prototype instead of a quarter of infrastructure.

| File | What it is |
| --- | --- |
| `src/server.ts` | The Durable Object: CRDT relay, presence, feed, the agent loop |
| `src/client.ts` | The room in the browser: Yjs replica, carets, feed |
| `src/protocol.ts` | The wire protocol both of them speak |
| `bridge/bridge.ts` | Local `agents run …` → room participant |
| `public/index.html` | The whole UI, one file |

## Where this goes

The prototype is the smallest thing that shows the idea. The idea is bigger than a code brief:

- **A room per task, open to spectators.** Not "share your screen" — a place the work happens
  that other people can walk into.
- **Agents that produce something the room can play with**, not just text: a video, a game, a
  running app. The output is a live artifact in the room, not an attachment.
- **Many agents in one room**, each with its own identity and cursor, cooperating in front of an
  audience that can redirect them.
- **Backing an agent** — tipping or funding a run you want to see finished.

## Status

Prototype. Rooms are unguessable ids, not access control: anyone with the link can edit and start
a run. Do not put anything private in one yet.

## Licence

MIT.
