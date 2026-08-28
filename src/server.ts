/**
 * agent-rooms — one Durable Object per room.
 *
 * The same object is the CRDT server, the presence server, the transcript
 * store, and the agent's runtime. That is the whole architecture: because a DO
 * is single-threaded and addressable by name, "the room" and "the agent's
 * memory" are one object, so there is no synchronisation problem between what
 * the humans are typing and what the agent is reading.
 */

import { Agent, routeAgentRequest, type Connection, type ConnectionContext, type WSMessage } from "agents";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createWorkersAI } from "workers-ai-provider";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { RunLimiter, type RunAllowance } from "./rate-limiter";
import { streamText, tool, stepCountIs } from "ai";
import { z } from "zod";
import * as Y from "yjs";
import {
  AGENT_COLOR,
  b64ToBytes,
  bytesToB64,
  type ClientMessage,
  type Peer,
  type RoomEvent,
  type PeerKind,
  type ServerMessage,
} from "./protocol";

export type Env = {
  RoomAgent: DurableObjectNamespace;
  ASSETS: Fetcher;
  /** Workers AI. Always present — this is the keyless default so a fresh deploy works. */
  AI: Ai;
  /** Optional, highest priority. Cheapest good model; see resolveModel(). */
  OPENROUTER_API_KEY?: string;
  /** Optional. */
  ANTHROPIC_API_KEY?: string;
  /** Per-IP run limiter (see src/rate-limiter.ts). */
  RunLimiter: DurableObjectNamespace<RunLimiter>;
  /** Runs allowed per IP per hour. Config, not a magic number in code. */
  RUNS_PER_IP_PER_HOUR: string;
};

/**
 * Which model drives the in-room agent, and what the room calls it.
 *
 * Provider and label are resolved TOGETHER, deliberately: they drifted apart
 * once already and the room spent a day telling every viewer it was running
 * Claude while actually running Workers AI.
 *
 * Priority: OpenRouter (cheapest capable) → Anthropic → Workers AI (keyless,
 * so a fresh clone deploys and works with no secrets at all).
 */
const OPENROUTER_MODEL = "deepseek/deepseek-v4-flash";
const ANTHROPIC_MODEL = "claude-sonnet-5";
const WORKERS_AI_MODEL = "@cf/openai/gpt-oss-120b";

function resolveModel(env: Env) {
  if (env.OPENROUTER_API_KEY) {
    return {
      model: createOpenRouter({ apiKey: env.OPENROUTER_API_KEY })(OPENROUTER_MODEL),
      label: "deepseek · cloud",
    };
  }
  if (env.ANTHROPIC_API_KEY) {
    return {
      model: createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })(ANTHROPIC_MODEL),
      label: "claude · cloud",
    };
  }
  return {
    model: createWorkersAI({ binding: env.AI })(WORKERS_AI_MODEL),
    label: "gpt-oss · cloud",
  };
}

type RoomState = {
  title: string;
  running: boolean;
  runner: string | null;
  /** Runs started in this room, ever. Bounded by MAX_RUNS_PER_ROOM. */
  runs: number;
};

/** Presence state we hang off each WebSocket connection. */
type ConnState = {
  name: string;
  color: string;
  kind: PeerKind;
  cursor: number | null;
  activity: string | null;
  /** Captured at connect: a WebSocket frame carries no headers to read it from later. */
  ip: string;
};

/**
 * The in-room agent's display name is DERIVED from the model actually running,
 * never hardcoded. Labelling a Workers AI run "claude" would be a lie the room
 * tells every viewer.
 */

const MAX_FEED = 400;
/**
 * A public demo link means strangers can start model runs on the deployer's
 * account. Cap it per room so one shared URL cannot drain a quota.
 */
const MAX_RUNS_PER_ROOM = 30;

/** Spectators are watchers, not authors — one muted colour for all of them. */
const SPECTATOR_COLOR = "#7a7a7a";

export class RoomAgent extends Agent<Env, RoomState> {
  initialState: RoomState = { title: "untitled room", running: false, runner: null, runs: 0 };

  /** Display name for the in-room agent, derived from the bound model. */
  private get agentName(): string {
    return resolveModel(this.env).label;
  }

  /** The shared brief. Authoritative copy; every client holds a replica. */
  private doc = new Y.Doc();
  private docLoaded = false;
  private abort: AbortController | null = null;

  // ---------------------------------------------------------------- storage

  private ensureTables() {
    this.sql`CREATE TABLE IF NOT EXISTS feed (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      actor TEXT NOT NULL,
      color TEXT NOT NULL,
      by TEXT NOT NULL DEFAULT 'human',
      kind TEXT NOT NULL,
      body TEXT NOT NULL
    )`;
    // Joins used to be persisted; they are broadcast-only now. Drop the old
    // rows so a room opened later shows work, not a list of arrivals.
    this.sql`DELETE FROM feed WHERE kind = 'join'`;
    this.sql`CREATE TABLE IF NOT EXISTS ydoc (
      id INTEGER PRIMARY KEY,
      update_b64 TEXT NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`;
  }

  /**
   * The room's watch-only token: random, minted once per room, persisted next
   * to the doc. There is no key material to configure — the room itself is the
   * only thing that can say which token it minted, which is exactly the access
   * model the rest of the room already uses (the DO is the truth).
   */
  private spectatorToken(): string {
    this.ensureTables();
    const rows = this.sql<{ value: string }>`SELECT value FROM meta WHERE key = 'spectator_token'`;
    if (rows.length > 0) return rows[0].value;
    const token = crypto.randomUUID().replaceAll("-", "");
    this.sql`INSERT INTO meta (key, value) VALUES ('spectator_token', ${token})`;
    return token;
  }

  /**
   * Rehydrate the Yjs document from SQLite. Called lazily because a DO can be
   * evicted and reconstructed at any time — the in-memory `doc` is a cache,
   * SQLite is the truth.
   */
  private loadDoc() {
    if (this.docLoaded) return;
    this.ensureTables();
    const rows = this.sql<{ update_b64: string }>`SELECT update_b64 FROM ydoc WHERE id = 1`;
    if (rows.length > 0) {
      try {
        Y.applyUpdate(this.doc, b64ToBytes(rows[0].update_b64));
      } catch {
        // A corrupt snapshot must not brick the room; start clean instead.
      }
    }
    this.docLoaded = true;
  }

  /** Persist the whole document. Cheap at prototype sizes; a real build would append updates. */
  private persistDoc() {
    const snapshot = bytesToB64(Y.encodeStateAsUpdate(this.doc));
    this.sql`INSERT INTO ydoc (id, update_b64) VALUES (1, ${snapshot})
             ON CONFLICT(id) DO UPDATE SET update_b64 = excluded.update_b64`;
  }

  private appendEvent(actor: string, color: string, by: PeerKind, kind: RoomEvent["kind"], body: string): RoomEvent {
    this.ensureTables();
    const ts = Date.now();
    this.sql`INSERT INTO feed (ts, actor, color, by, kind, body)
             VALUES (${ts}, ${actor}, ${color}, ${by}, ${kind}, ${body})`;
    const [row] = this.sql<{ id: number }>`SELECT last_insert_rowid() AS id`;
    this.sql`DELETE FROM feed WHERE id <= ${row.id - MAX_FEED}`;
    const event: RoomEvent = { id: row.id, ts, actor, color, by, kind, body };
    this.send({ t: "event", event });
    return event;
  }

  /**
   * Join and leave notices are broadcast but never stored. A reconnect is not
   * a fact worth keeping, and persisting them buries the actual work under
   * "x joined the room" for anyone who opens the link later.
   */
  private announce(actor: string, color: string, by: PeerKind, body: string) {
    this.send({ t: "event", event: { id: -Date.now(), ts: Date.now(), actor, color, by, kind: "join", body } });
  }

  private recentEvents(): RoomEvent[] {
    this.ensureTables();
    const rows = this.sql<RoomEvent>`SELECT id, ts, actor, color, by, kind, body
                                     FROM feed ORDER BY id DESC LIMIT ${MAX_FEED}`;
    return rows.reverse();
  }

  // ------------------------------------------------------------- broadcast

  private send(msg: ServerMessage, without?: string[]) {
    this.broadcast(JSON.stringify(msg), without);
  }

  private peers(): Peer[] {
    const out: Peer[] = [];
    for (const conn of this.getConnections<ConnState>()) {
      const s = conn.state;
      if (!s?.name) continue;
      out.push({ id: conn.id, name: s.name, color: s.color, kind: s.kind, cursor: s.cursor ?? null, activity: s.activity ?? null });
    }
    // The cloud agent has no socket of its own — it runs inside this object.
    // Append it here so it cannot be dropped by an unrelated presence update
    // (a human moving their caret used to make it vanish mid-run).
    if (this.agentPeer) out.push(this.agentPeer);
    return out;
  }

  private sendPeers() {
    this.send({ t: "peers", peers: this.peers() });
  }

  // ------------------------------------------------------------- lifecycle

  /** Constant-time check of a presented watch token against the room's own. */
  private isSpectatorToken(presented: string): boolean {
    const enc = new TextEncoder();
    const a = enc.encode(presented);
    const b = enc.encode(this.spectatorToken());
    return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
  }

  async onConnect(conn: Connection<ConnState>, ctx: ConnectionContext) {
    this.loadDoc();
    const url = new URL(ctx.request.url);
    const name = (url.searchParams.get("as") || "guest").slice(0, 24);

    // A connection presenting `v` is asking to WATCH. A valid token joins
    // read-only; an invalid one is turned away at the door rather than being
    // quietly upgraded to an editor.
    const presented = url.searchParams.get("v");
    if (presented !== null && !this.isSpectatorToken(presented)) {
      conn.send(JSON.stringify({ t: "error", message: "this watch link is not valid for this room" } satisfies ServerMessage));
      conn.close(1008, "invalid spectator token");
      return;
    }
    const kind: PeerKind =
      presented !== null ? "spectator" : url.searchParams.get("kind") === "agent" ? "agent" : "human";
    const color =
      kind === "agent" ? AGENT_COLOR :
      kind === "spectator" ? SPECTATOR_COLOR :
      url.searchParams.get("color") || "#38bdf8";

    const ip = ctx.request.headers.get("cf-connecting-ip") ?? "unknown";
    conn.setState({ name, color, kind, cursor: null, activity: null, ip });

    const welcome: ServerMessage = {
      t: "welcome",
      you: { id: conn.id, name, color, kind, cursor: null, activity: null },
      title: this.state.title,
      running: this.state.running,
      events: this.recentEvents(),
      // Editors get the watch token so they can hand out watch-only links.
      // Spectators do not get it back — they hold a link, not the room.
      ...(kind === "spectator" ? {} : { spectatorToken: this.spectatorToken() }),
    };
    conn.send(JSON.stringify(welcome));

    // Start the Yjs handshake from our side so a fresh client gets the doc
    // even if it never speaks first.
    conn.send(JSON.stringify({ t: "sync1", sv: bytesToB64(Y.encodeStateVector(this.doc)) } satisfies ServerMessage));

    this.announce(
      name,
      color,
      kind,
      kind === "agent" ? "joined the room as an agent" : kind === "spectator" ? "is watching" : "joined the room",
    );
    this.sendPeers();
  }

  async onClose(conn: Connection<ConnState>) {
    const s = conn.state;
    if (s?.name) this.announce(s.name, s.color, s.kind, "left the room");
    // The connection is already gone from getConnections() by the time this
    // fires, so a plain re-broadcast is correct.
    this.sendPeers();
  }

  async onMessage(conn: Connection<ConnState>, raw: WSMessage) {
    if (typeof raw !== "string") return;
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    this.loadDoc();
    const me = conn.state;

    // Read-only means read-only: a spectator is refused on EVERY mutating
    // message, not just the obvious ones — otherwise "watch-only" quietly
    // leaves renaming the room or killing a run on the table.
    if (me?.kind === "spectator") {
      switch (msg.t) {
        case "update":
        case "steer":
        case "run":
        case "stop":
        case "title":
        case "event":
          conn.send(JSON.stringify({ t: "error", message: "you are watching this room — spectators cannot edit, steer or run" } satisfies ServerMessage));
          return;
        case "cursor":
          // Watchers do not get a caret in the document; drop it silently.
          return;
      }
    }

    switch (msg.t) {
      // --- Yjs sync. The room never interprets the document; it merges and relays.
      case "sync1": {
        const update = Y.encodeStateAsUpdate(this.doc, b64ToBytes(msg.sv));
        conn.send(JSON.stringify({ t: "sync2", update: bytesToB64(update) } satisfies ServerMessage));
        break;
      }
      case "update": {
        Y.applyUpdate(this.doc, b64ToBytes(msg.update));
        this.persistDoc();
        // Relay verbatim to every other replica. CRDT merge makes order irrelevant.
        this.send({ t: "update", update: msg.update }, [conn.id]);
        break;
      }

      // --- presence
      case "cursor": {
        if (!me) break;
        conn.setState({ ...me, cursor: msg.cursor, activity: msg.activity ?? me.activity });
        this.sendPeers();
        break;
      }

      // --- the feed
      case "steer": {
        if (!me || !msg.text.trim()) break;
        this.appendEvent(me.name, me.color, me.kind, "steer", msg.text.trim());
        break;
      }
      case "event": {
        if (!me) break;
        this.appendEvent(me.name, me.color, me.kind, msg.kind, msg.body);
        break;
      }
      case "title": {
        this.setState({ ...this.state, title: msg.title.slice(0, 60) });
        this.send({ t: "title", title: this.state.title });
        break;
      }

      // --- the cloud agent
      case "run": {
        if (this.state.running) {
          conn.send(JSON.stringify({ t: "error", message: "a run is already in flight" } satisfies ServerMessage));
          break;
        }
        const allowance = await this.checkRunAllowance(me?.ip ?? "unknown");
        if (!allowance.ok) {
          const mins = Math.ceil(allowance.retryAfterSeconds / 60);
          conn.send(JSON.stringify({
            t: "error",
            message: `run limit reached for your connection — try again in ${mins} minute${mins === 1 ? "" : "s"}`,
          } satisfies ServerMessage));
          break;
        }
        if (this.state.runs >= MAX_RUNS_PER_ROOM) {
          conn.send(JSON.stringify({
            t: "error",
            message: `this room has used its ${MAX_RUNS_PER_ROOM} runs — open a new room to keep going`,
          } satisfies ServerMessage));
          break;
        }
        void this.startRun(msg.prompt);
        break;
      }
      case "stop": {
        this.abort?.abort();
        break;
      }
    }
  }

  // ----------------------------------------------------------- cloud agent

  /**
   * Ask this IP's limiter object whether another run is allowed. Fails OPEN:
   * a limiter that errors must not take the room down with it.
   */
  private async checkRunAllowance(ip: string): Promise<RunAllowance> {
    try {
      const limit = Number.parseInt(this.env.RUNS_PER_IP_PER_HOUR ?? "10", 10);
      const stub = this.env.RunLimiter.get(this.env.RunLimiter.idFromName(ip));
      return await stub.consume(limit);
    } catch {
      return { ok: true, remaining: -1, retryAfterSeconds: 0 };
    }
  }

  /** The brief, as text. Re-read on every step so mid-run edits actually land. */
  private brief(): string {
    this.loadDoc();
    return this.doc.getText("brief").toString();
  }

  /** Move the agent's caret in the shared document, so everyone sees where it is working. */
  private setAgentCursor(cursor: number | null, activity: string | null) {
    this.agentPeer = { id: "cloud-agent", name: this.agentName, color: AGENT_COLOR, kind: "agent", cursor, activity };
    this.sendPeers();
  }

  /**
   * The cloud agent has no WebSocket of its own — it lives inside this object,
   * so it is injected into the presence list as a synthetic peer while a run
   * is in flight.
   */
  private agentPeer: Peer | null = null;

  /** Scheduled callback — must be public for the alarm to reach it. */
  clearAgentPeer() {
    this.agentPeer = null;
    this.sendPeers();
  }

  private async startRun(prompt: string) {
    const { model } = resolveModel(this.env);

    this.setState({ ...this.state, running: true, runner: this.agentName, runs: (this.state.runs ?? 0) + 1 });
    this.send({ t: "running", running: true, runner: this.agentName });
    this.abort = new AbortController();

    try {
      // A DO is evicted after ~70-140s idle. runFiber keeps it alive for the
      // duration and checkpoints progress so an eviction mid-stream is
      // recoverable rather than fatal.
      await this.runFiber("cloud-run", async (ctx) => {
        const brief = this.brief();
        this.setAgentCursor(0, "reading the brief");

        const result = streamText({
          model,
          abortSignal: this.abort!.signal,
          stopWhen: stepCountIs(8),
          system: [
            "You are an agent participating in a shared, live-edited room alongside human collaborators.",
            "The BRIEF below is a document the humans are editing WHILE you work — re-read it via read_brief before concluding.",
            "You have a visible cursor in their document. Call focus_line whenever you move your attention, so they can see what you are working on.",
            "When you produce something concrete the room should keep, call append_to_brief — it types into the shared document in front of everyone.",
            "Be concise. Think out loud in short lines, not paragraphs.",
            "",
            "BRIEF:",
            brief || "(empty — the room has not written anything yet)",
          ].join("\n"),
          prompt,
          tools: {
            read_brief: tool({
              description: "Re-read the shared brief. It may have changed since you started.",
              inputSchema: z.object({}),
              execute: async () => {
                this.appendEvent(this.agentName, AGENT_COLOR, "agent", "tool", "read_brief — checking for edits");
                return { brief: this.brief() };
              },
            }),
            focus_line: tool({
              description: "Park your cursor on a line of the brief so collaborators can see what you are working on.",
              inputSchema: z.object({
                line: z.number().describe("1-based line number in the brief"),
                activity: z.string().describe("2-3 words, e.g. 'reading' or 'planning edit'"),
              }),
              execute: async ({ line, activity }) => {
                const text = this.brief();
                const lines = text.split("\n");
                const idx = Math.max(0, Math.min(lines.length - 1, line - 1));
                const offset = lines.slice(0, idx).reduce((n, l) => n + l.length + 1, 0);
                this.setAgentCursor(offset, activity);
                return { ok: true, line: idx + 1 };
              },
            }),
            append_to_brief: tool({
              description: "Type text into the shared brief. Everyone sees it appear live.",
              inputSchema: z.object({ text: z.string() }),
              execute: async ({ text }) => {
                await this.typeIntoBrief(text);
                this.appendEvent(this.agentName, AGENT_COLOR, "agent", "edit", `wrote ${text.trim().split("\n").length} line(s) into the brief`);
                return { ok: true };
              },
            }),
          },
          onError: ({ error }) => {
            this.appendEvent("room", "#f87171", "agent", "system", `model error: ${String(error)}`);
          },
        });

        let buffered = "";
        for await (const delta of result.textStream) {
          buffered += delta;
          this.send({ t: "delta", actor: this.agentName, color: AGENT_COLOR, by: "agent", text: delta });
          ctx.stash({ soFar: buffered });
        }
        if (buffered.trim()) {
          // Persist the finished turn so late joiners see it in the feed.
          this.sql`INSERT INTO feed (ts, actor, color, by, kind, body)
                   VALUES (${Date.now()}, ${this.agentName}, ${AGENT_COLOR}, 'agent', 'say', ${buffered.trim()})`;
        }
      });
    } catch (err) {
      this.appendEvent("room", "#f87171", "agent", "system", `run failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.abort = null;
      this.setState({ ...this.state, running: false, runner: null });
      this.send({ t: "running", running: false, runner: null });
      // Leave the agent in the room for a beat with a "done" flag. Vanishing
      // the instant the last token lands makes a finished run look like a room
      // nobody was ever in.
      if (this.agentPeer) {
        this.agentPeer = { ...this.agentPeer, activity: "done" };
        this.sendPeers();
        await this.schedule(8, "clearAgentPeer", {});
      }
    }
  }

  /** Insert text into the shared doc in small chunks so it visibly types. */
  private async typeIntoBrief(text: string) {
    this.loadDoc();
    const ytext = this.doc.getText("brief");
    const chunks = text.match(/.{1,6}/gs) ?? [];
    for (const chunk of chunks) {
      const before = Y.encodeStateVector(this.doc);
      ytext.insert(ytext.length, chunk);
      this.setAgentCursor(ytext.length, "writing");
      this.send({ t: "update", update: bytesToB64(Y.encodeStateAsUpdate(this.doc, before)) });
      await new Promise((r) => setTimeout(r, 18));
    }
    this.persistDoc();
  }

  /** After an eviction mid-run, tell the room what was lost rather than lying about it. */
  async onFiberRecovered(ctx: { name: string; snapshot: unknown }) {
    if (ctx.name !== "cloud-run") return;
    const soFar = (ctx.snapshot as { soFar?: string } | null)?.soFar;
    this.setState({ ...this.state, running: false, runner: null });
    this.appendEvent(
      "room",
      "#fbbf24",
      "agent",
      "system",
      soFar
        ? `the run was interrupted by an eviction after ${soFar.length} characters — recovered from checkpoint`
        : "the run was interrupted by an eviction",
    );
  }

  // ------------------------------------------------------------------ HTTP

  /** Plain-HTTP surface, used by the bridge and for a quick transcript export. */
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/export")) {
      this.loadDoc();
      return Response.json({
        title: this.state.title,
        brief: this.brief(),
        events: this.recentEvents(),
      });
    }
    return new Response("agent-rooms", { status: 200 });
  }
}

export { RunLimiter };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routeAgentRequest(request, env)) ||
      env.ASSETS.fetch(request)
    );
  },
} satisfies ExportedHandler<Env>;
