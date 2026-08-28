/**
 * Spectator mode, end to end: a real `wrangler dev` (workerd), real
 * WebSockets, the real RoomAgent Durable Object. No mocks.
 *
 * What must hold:
 *   - an editor's welcome carries the room's watch token; a spectator's does not
 *   - a spectator receives the document and the live feed (state streams in)
 *   - a spectator is refused on update / steer / run (and every other mutation)
 *   - a wrong token is turned away at connect (close 1008)
 *   - editors are unaffected: edits relay, steers land, runs start
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import * as Y from "yjs";
import { b64ToBytes, bytesToB64, type ServerMessage } from "./protocol";

const PORT = 8977;
const BASE = `ws://127.0.0.1:${PORT}`;
let dev: ReturnType<typeof Bun.spawn>;

/** A WS client that queues every server message and lets tests await one. */
class Client {
  private queue: ServerMessage[] = [];
  private waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];
  closed: Promise<{ code: number }>;
  private ws: WebSocket;

  constructor(room: string, params: Record<string, string>) {
    const qs = new URLSearchParams(params);
    this.ws = new WebSocket(`${BASE}/agents/room-agent/${room}?${qs}`);
    this.closed = new Promise((resolve) => {
      this.ws.addEventListener("close", (ev) => resolve({ code: ev.code }));
    });
    this.ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as ServerMessage;
      const i = this.waiters.findIndex((w) => w.pred(msg));
      if (i >= 0) this.waiters.splice(i, 1)[0].resolve(msg);
      else this.queue.push(msg);
    });
  }

  async open() {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve());
      this.ws.addEventListener("error", () => reject(new Error("ws error")));
    });
  }

  send(msg: unknown) {
    this.ws.send(JSON.stringify(msg));
  }

  /** Next message matching pred — from the backlog or the future. */
  waitFor<T extends ServerMessage>(pred: (m: ServerMessage) => boolean, ms = 10_000): Promise<T> {
    const i = this.queue.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.queue.splice(i, 1)[0] as T);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for message after ${ms}ms`)), ms);
      this.waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m as T);
        },
      });
    });
  }

  /** Assert NO message matching pred arrives within ms. */
  async expectSilence(pred: (m: ServerMessage) => boolean, ms = 1_500) {
    const got = await this.waitFor(pred, ms).catch(() => null);
    expect(got).toBeNull();
  }

  close() {
    this.ws.close();
  }
}

beforeAll(async () => {
  // --local: the Workers AI binding is a remote binding, and letting wrangler
  // open its remote proxy session would demand Cloudflare auth just to run
  // tests. Nothing under test touches the model.
  dev = Bun.spawn(["bunx", "wrangler", "dev", "--local", "--port", String(PORT)], {
    cwd: `${import.meta.dir}/..`,
    env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${PORT}/`);
      return;
    } catch {
      await Bun.sleep(500);
    }
  }
  throw new Error("wrangler dev did not come up within 60s");
}, 70_000);

afterAll(() => {
  dev?.kill();
});

// One room per test file run, so reruns against the same local state stay clean.
const ROOM = `spec-test-${Date.now().toString(36)}`;

test("editor gets the watch token; spectator joins read-only and is refused on every mutation", async () => {
  const editor = new Client(ROOM, { as: "editor", kind: "human", color: "#38bdf8" });
  await editor.open();
  const edWelcome = await editor.waitFor<Extract<ServerMessage, { t: "welcome" }>>((m) => m.t === "welcome");
  expect(edWelcome.you.kind).toBe("human");
  expect(edWelcome.spectatorToken).toMatch(/^[0-9a-f]{32}$/);
  const token = edWelcome.spectatorToken!;

  // The editor writes into the brief before anyone is watching.
  const edDoc = new Y.Doc();
  edDoc.getText("brief").insert(0, "hello from the editor");
  editor.send({ t: "update", update: bytesToB64(Y.encodeStateAsUpdate(edDoc)) });

  // Spectator connects with the token.
  const spec = new Client(ROOM, { as: "watcher", v: token });
  await spec.open();
  const spWelcome = await spec.waitFor<Extract<ServerMessage, { t: "welcome" }>>((m) => m.t === "welcome");
  expect(spWelcome.you.kind).toBe("spectator");
  expect(spWelcome.spectatorToken).toBeUndefined();

  // State streams in: the Yjs handshake hands the spectator the document.
  await spec.waitFor((m) => m.t === "sync1");
  spec.send({ t: "sync1", sv: bytesToB64(Y.encodeStateVector(new Y.Doc())) });
  const sync2 = await spec.waitFor<Extract<ServerMessage, { t: "sync2" }>>((m) => m.t === "sync2");
  const spDoc = new Y.Doc();
  Y.applyUpdate(spDoc, b64ToBytes(sync2.update));
  expect(spDoc.getText("brief").toString()).toBe("hello from the editor");

  // The presence rail knows the difference.
  const peersMsg = await editor.waitFor<Extract<ServerMessage, { t: "peers" }>>(
    (m) => m.t === "peers" && m.peers.some((p) => p.kind === "spectator"),
  );
  expect(peersMsg.peers.find((p) => p.kind === "spectator")?.name).toBe("watcher");

  // Every mutating message is refused with an error...
  const refused = /spectators cannot/;
  for (const msg of [
    { t: "update", update: bytesToB64(Y.encodeStateAsUpdate(edDoc)) },
    { t: "steer", text: "let me drive" },
    { t: "run", prompt: "do something" },
    { t: "title", title: "hijacked" },
    { t: "event", kind: "say", body: "spoofed" },
    { t: "stop" },
  ]) {
    spec.send(msg);
    const err = await spec.waitFor<Extract<ServerMessage, { t: "error" }>>((m) => m.t === "error");
    expect(err.message).toMatch(refused);
  }

  // ...and none of it reached the room: the editor saw no update, no steer
  // event, no title change, no run starting.
  await editor.expectSilence((m) =>
    m.t === "update" || m.t === "title" || (m.t === "event" && m.event.kind !== "join") || (m.t === "running" && m.running),
  );

  // Editors are unaffected. A steer lands and the spectator watches it happen.
  editor.send({ t: "steer", text: "steady as she goes" });
  const steer = await spec.waitFor<Extract<ServerMessage, { t: "event" }>>(
    (m) => m.t === "event" && m.event.kind === "steer",
  );
  expect(steer.event.body).toBe("steady as she goes");

  // A run starts (the model call itself may fail locally — the gate is what
  // is under test, and `running: true` is broadcast before any model I/O).
  editor.send({ t: "run", prompt: "just checking the door" });
  const running = await editor.waitFor<Extract<ServerMessage, { t: "running" }>>((m) => m.t === "running");
  expect(running.running).toBe(true);

  editor.close();
  spec.close();
}, 60_000);

test("a wrong token is turned away at connect with close 1008", async () => {
  const intruder = new Client(ROOM, { as: "sneaky", v: "deadbeefdeadbeefdeadbeefdeadbeef" });
  await intruder.open();
  const err = await intruder.waitFor<Extract<ServerMessage, { t: "error" }>>((m) => m.t === "error");
  expect(err.message).toMatch(/not valid/);
  const { code } = await intruder.closed;
  expect(code).toBe(1008);
}, 30_000);
