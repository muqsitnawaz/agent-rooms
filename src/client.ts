/**
 * The room, in the browser.
 *
 * Three things happen here and nothing else:
 *   1. a Yjs replica of the shared brief, bound to a plain <textarea>
 *   2. remote carets drawn over that textarea from the presence list
 *   3. the activity feed, appended to as agents stream
 */

import * as Y from "yjs";
import { b64ToBytes, bytesToB64, COLORS, type Peer, type PeerKind, type RoomEvent, type ServerMessage } from "./protocol";

// ---------------------------------------------------------------- identity

const ADJECTIVES = ["swift", "quiet", "bright", "clever", "calm", "keen", "bold", "warm"];
const ANIMALS = ["otter", "heron", "lynx", "sparrow", "marten", "ibex", "vireo", "shrike"];

function randomName() {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const b = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  return `${a} ${b}`;
}

/**
 * Identity lives in sessionStorage, not localStorage, on purpose: it is
 * per-tab, so two windows on one machine are two different people. That is
 * what makes the demo possible without a second laptop, and it still survives
 * a reload.
 */
const store = {
  get name() {
    let n = sessionStorage.getItem("agent-room:name");
    if (!n) {
      n = randomName();
      sessionStorage.setItem("agent-room:name", n);
    }
    return n;
  },
  set name(v: string) {
    sessionStorage.setItem("agent-room:name", v);
  },
  get color() {
    let c = sessionStorage.getItem("agent-room:color");
    if (!c) {
      // Skip index 0 — that colour belongs to the agent.
      c = COLORS[1 + Math.floor(Math.random() * (COLORS.length - 1))];
      sessionStorage.setItem("agent-room:color", c);
    }
    return c;
  },
};

// -------------------------------------------------------------------- room

/**
 * `#/r/<room>` joins as an editor; `#/r/<room>?v=<token>` joins as a
 * spectator. The token rides in the fragment so the page load itself never
 * sends it; it does still travel in the WebSocket upgrade's query string,
 * where the room reads it (same channel the room id already uses).
 */
function parseRoom(): { id: string; watchToken: string | null } {
  const m = location.hash.match(/^#\/r\/([A-Za-z0-9_-]{1,64})(?:\?v=([A-Za-z0-9_-]{1,128}))?$/);
  if (m) return { id: m[1], watchToken: m[2] ?? null };
  const id = `${ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]}-${ANIMALS[Math.floor(Math.random() * ANIMALS.length)]}-${Math.random().toString(36).slice(2, 6)}`;
  location.hash = `#/r/${id}`;
  return { id, watchToken: null };
}

const { id: ROOM, watchToken } = parseRoom();
/** True when this tab is watch-only. Decided by the URL, enforced by the server. */
const SPECTATING = watchToken !== null;
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

const el = {
  title: $<HTMLInputElement>("#title"),
  humans: $<HTMLDivElement>("#humans"),
  agents: $<HTMLDivElement>("#agents"),
  specs: $<HTMLDivElement>("#specs"),
  humanCount: $<HTMLSpanElement>("#humanCount"),
  agentCount: $<HTMLSpanElement>("#agentCount"),
  specCount: $<HTMLSpanElement>("#specCount"),
  agentRail: $<HTMLDivElement>("#agentRail"),
  specRail: $<HTMLDivElement>("#specRail"),
  brief: $<HTMLTextAreaElement>("#brief"),
  carets: $<HTMLDivElement>("#carets"),
  feed: $<HTMLDivElement>("#feed"),
  composer: $<HTMLInputElement>("#composer"),
  run: $<HTMLButtonElement>("#run"),
  share: $<HTMLButtonElement>("#share"),
  watch: $<HTMLButtonElement>("#watch"),
  status: $<HTMLSpanElement>("#status"),
  me: $<HTMLSpanElement>("#me"),
  roomName: $<HTMLSpanElement>("#roomName"),
};

el.roomName.textContent = ROOM;

// ---------------------------------------------------------------- document

const doc = new Y.Doc();
const ytext = doc.getText("brief");
let ws: WebSocket | null = null;
let applyingRemote = false;
let myId = "";

let generation = 0;

function connect() {
  const mine = ++generation;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const qs = new URLSearchParams({ as: store.name, color: store.color, kind: "human" });
  if (watchToken) qs.set("v", watchToken);
  const sock = new WebSocket(`${proto}//${location.host}/agents/room-agent/${ROOM}?${qs}`);
  ws = sock;

  sock.onopen = () => {
    if (mine !== generation) return sock.close();
    setStatus("live", true);
    send({ t: "sync1", sv: bytesToB64(Y.encodeStateVector(doc)) });
  };
  // Guarded by generation: a superseded socket closing late would otherwise
  // repaint "reconnecting" over a connection that is already live.
  sock.onclose = (ev) => {
    if (mine !== generation) return;
    // 1008 = the room turned this connection away (bad watch token).
    // Retrying would just knock on the same locked door once a second.
    if (ev.code === 1008) {
      setStatus("watch link not valid", false);
      return;
    }
    setStatus("reconnecting", false);
    setTimeout(connect, 1000);
  };
  sock.onmessage = (ev) => {
    if (mine !== generation) return;
    handle(JSON.parse(ev.data) as ServerMessage);
  };
}

/**
 * Everything a spectator must not do, dropped at the source. The server
 * enforces this anyway; the client guard just keeps a watch-only tab from
 * arguing with the room (the Yjs sync1 reply, for one, is an `update`).
 */
const MUTATING = new Set(["update", "steer", "run", "stop", "title", "event", "cursor"]);

function send(msg: { t: string } & Record<string, unknown>) {
  if (SPECTATING && MUTATING.has(msg.t)) return;
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function setStatus(text: string, live: boolean) {
  el.status.textContent = text;
  el.status.classList.toggle("live", live);
}

// Local edits -> Yjs -> the room.
doc.on("update", (update: Uint8Array, origin: unknown) => {
  if (origin === "remote") return;
  send({ t: "update", update: bytesToB64(update) });
});

// Yjs -> the textarea. Preserve the local caret across remote inserts by
// converting it to a relative position first.
ytext.observe(() => {
  const rel = Y.createRelativePositionFromTypeIndex(ytext, el.brief.selectionStart);
  const hadFocus = document.activeElement === el.brief;
  applyingRemote = true;
  el.brief.value = ytext.toString();
  applyingRemote = false;
  const abs = Y.createAbsolutePositionFromRelativePosition(rel, doc);
  if (hadFocus && abs) el.brief.setSelectionRange(abs.index, abs.index);
  drawCarets();
});

/** Minimal prefix/suffix diff — enough for keystrokes, paste, and select-and-type. */
function applyLocalEdit(next: string) {
  const prev = ytext.toString();
  if (prev === next) return;
  let start = 0;
  while (start < prev.length && start < next.length && prev[start] === next[start]) start++;
  let endPrev = prev.length;
  let endNext = next.length;
  while (endPrev > start && endNext > start && prev[endPrev - 1] === next[endNext - 1]) {
    endPrev--;
    endNext--;
  }
  doc.transact(() => {
    if (endPrev > start) ytext.delete(start, endPrev - start);
    if (endNext > start) ytext.insert(start, next.slice(start, endNext));
  });
}

el.brief.addEventListener("input", () => {
  if (applyingRemote) return;
  applyLocalEdit(el.brief.value);
  reportCursor();
});
["keyup", "click", "select", "focus"].forEach((e) =>
  el.brief.addEventListener(e, () => reportCursor()),
);
el.brief.addEventListener("scroll", () => drawCarets());

let cursorTimer: number | undefined;
function reportCursor() {
  clearTimeout(cursorTimer);
  cursorTimer = window.setTimeout(() => send({ t: "cursor", cursor: el.brief.selectionStart }), 30);
}

// ----------------------------------------------------------------- carets

let peers: Peer[] = [];
let lineH = 22;

/**
 * A hidden div that mirrors the textarea's box and typography exactly. To find
 * where offset N sits on screen we put the text up to N into the mirror,
 * followed by a zero-width marker, and read the marker's position. Arithmetic
 * (col x charWidth) would be cheaper but only works with wrapping disabled —
 * and a shared brief that scrolls sideways is not a document anyone wants.
 */
const mirror = document.createElement("div");
mirror.setAttribute("aria-hidden", "true");
const marker = document.createElement("span");
marker.textContent = "\u200b";
document.body.appendChild(mirror);

function measure() {
  const cs = getComputedStyle(el.brief);
  lineH = parseFloat(cs.lineHeight);
  mirror.style.cssText = [
    "position:absolute", "visibility:hidden", "pointer-events:none",
    "top:0", "left:-9999px",
    `width:${el.brief.clientWidth}px`,
    `font:${cs.font}`,
    `line-height:${cs.lineHeight}`,
    `padding:${cs.padding}`,
    `letter-spacing:${cs.letterSpacing}`,
    `tab-size:${cs.tabSize}`,
    "white-space:pre-wrap", "word-break:break-word", "box-sizing:border-box",
  ].join(";");
}

function offsetToPoint(text: string, offset: number): { x: number; y: number } {
  mirror.textContent = text.slice(0, offset);
  mirror.appendChild(marker);
  const m = marker.getBoundingClientRect();
  const box = mirror.getBoundingClientRect();
  return { x: m.left - box.left, y: m.top - box.top };
}

/** Draw every remote caret over the textarea, offset by its scroll position. */
function drawCarets() {
  const text = ytext.toString();
  el.carets.innerHTML = "";
  for (const p of peers) {
    if (p.id === myId || p.cursor == null || p.kind === "spectator") continue;
    const isAgent = p.kind === "agent";
    const pt = offsetToPoint(text, Math.min(p.cursor, text.length));
    const x = pt.x - el.brief.scrollLeft;
    const y = pt.y - el.brief.scrollTop;

    // An agent also lights up the whole line it is working on. A human never
    // does — so "the machine is looking here" is legible without reading.
    if (isAgent) {
      const glow = document.createElement("div");
      glow.className = "lineglow";
      glow.style.top = `${y}px`;
      glow.style.height = `${lineH}px`;
      el.carets.appendChild(glow);
    }

    const caret = document.createElement("div");
    caret.className = `caret${isAgent ? " agent" : ""}`;
    caret.style.left = `${x}px`;
    caret.style.top = `${y}px`;
    caret.style.height = `${lineH}px`;
    caret.style.background = p.color;

    const flag = document.createElement("div");
    flag.className = "flag";
    flag.style.background = p.color;
    flag.textContent = isAgent
      ? `◆ ${p.name}${p.activity ? ` · ${p.activity}` : ""}`
      : p.name;
    caret.appendChild(flag);
    el.carets.appendChild(caret);
  }
}

function drawPeers() {
  const humans = peers.filter((p) => p.kind === "human");
  const agents = peers.filter((p) => p.kind === "agent");
  const specs = peers.filter((p) => p.kind === "spectator");
  const chip = (p: Peer) => {
    const dot = document.createElement("div");
    dot.className = `peer${p.kind === "agent" ? " agent" : ""}${p.kind === "spectator" ? " spectator" : ""}`;
    dot.title = p.kind === "agent" ? `${p.name} (agent)` : p.kind === "spectator" ? `${p.name} (watching)` : `${p.name} (human)`;
    if (p.kind === "spectator") {
      // Watchers are hollow: no fill, no initials — an eye, not an author.
      dot.textContent = "◎";
    } else {
      dot.style.background = p.color;
      dot.textContent = p.kind === "agent"
        ? "◆"
        : p.name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
    }
    if (p.kind === "agent" && p.activity) dot.classList.add("busy");
    return dot;
  };
  el.humans.innerHTML = "";
  el.agents.innerHTML = "";
  el.specs.innerHTML = "";
  for (const p of humans) el.humans.appendChild(chip(p));
  for (const p of agents) el.agents.appendChild(chip(p));
  for (const p of specs) el.specs.appendChild(chip(p));
  el.humanCount.textContent = String(humans.length);
  el.agentCount.textContent = String(agents.length);
  el.specCount.textContent = String(specs.length);
  el.agentRail.classList.toggle("empty", agents.length === 0);
  el.specRail.classList.toggle("empty", specs.length === 0);
}

// ------------------------------------------------------------------- feed

let liveBubble: { actor: string; node: HTMLDivElement; body: HTMLDivElement } | null = null;

function atBottom() {
  return el.feed.scrollHeight - el.feed.scrollTop - el.feed.clientHeight < 80;
}

function feedRow(actor: string, color: string, by: PeerKind, kind: RoomEvent["kind"], body: string) {
  const stick = atBottom();
  const row = document.createElement("div");
  row.className = `row ${kind} by-${by}`;
  const dot = document.createElement("span");
  dot.className = "dot";
  dot.style.background = color;
  const who = document.createElement("span");
  who.className = "who";
  who.style.color = color;
  who.textContent = by === "agent" ? `◆ ${actor}` : actor;
  const text = document.createElement("div");
  text.className = "body";
  text.textContent = body;
  row.append(dot, who, text);
  el.feed.appendChild(row);
  if (stick) el.feed.scrollTop = el.feed.scrollHeight;
  return { row, text };
}

function handle(msg: ServerMessage) {
  switch (msg.t) {
    case "welcome": {
      myId = msg.you.id;
      el.me.textContent = SPECTATING ? `${msg.you.name} · watching` : msg.you.name;
      el.me.style.color = msg.you.color;
      if (msg.spectatorToken && !SPECTATING) {
        watchUrl = `${location.origin}${location.pathname}#/r/${ROOM}?v=${msg.spectatorToken}`;
        el.watch.hidden = false;
      }
      el.title.value = msg.title === "untitled room" ? "" : msg.title;
      el.feed.innerHTML = "";
      for (const e of msg.events) feedRow(e.actor, e.color, e.by, e.kind, e.body);
      setRunning(msg.running);
      el.feed.scrollTop = el.feed.scrollHeight;
      break;
    }
    case "sync1": {
      send({ t: "update", update: bytesToB64(Y.encodeStateAsUpdate(doc, b64ToBytes(msg.sv))) });
      break;
    }
    case "sync2":
    case "update": {
      Y.applyUpdate(doc, b64ToBytes(msg.update), "remote");
      break;
    }
    case "peers": {
      peers = msg.peers;
      drawPeers();
      drawCarets();
      break;
    }
    case "event": {
      liveBubble = null;
      feedRow(msg.event.actor, msg.event.color, msg.event.by, msg.event.kind, msg.event.body);
      break;
    }
    case "delta": {
      // Token stream: keep appending into one bubble instead of a row per token.
      if (!liveBubble || liveBubble.actor !== msg.actor) {
        const { row, text } = feedRow(msg.actor, msg.color, msg.by, "say", "");
        row.classList.add("streaming");
        liveBubble = { actor: msg.actor, node: row as HTMLDivElement, body: text as HTMLDivElement };
      }
      const stick = atBottom();
      liveBubble.body.textContent += msg.text;
      if (stick) el.feed.scrollTop = el.feed.scrollHeight;
      break;
    }
    case "running": {
      setRunning(msg.running);
      if (!msg.running && liveBubble) {
        liveBubble.node.classList.remove("streaming");
        liveBubble = null;
      }
      break;
    }
    case "title": {
      if (document.activeElement !== el.title) el.title.value = msg.title === "untitled room" ? "" : msg.title;
      break;
    }
    case "error": {
      feedRow("room", "#f87171", "agent", "system", msg.message);
      break;
    }
  }
}

function setRunning(running: boolean) {
  el.run.textContent = running ? "Stop" : "Run agent";
  el.run.classList.toggle("stop", running);
  el.run.dataset.running = String(running);
}

// ------------------------------------------------------------------- wire

el.run.addEventListener("click", () => {
  if (el.run.dataset.running === "true") {
    send({ t: "stop" });
    return;
  }
  const prompt = el.composer.value.trim() || "Read the brief and get started. Keep the room posted as you go.";
  el.composer.value = "";
  send({ t: "run", prompt });
});

el.composer.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const text = el.composer.value.trim();
  if (!text) return;
  el.composer.value = "";
  send({ t: "steer", text });
});

function flashCopied(btn: HTMLButtonElement) {
  const before = btn.textContent;
  btn.textContent = "Copied";
  btn.classList.add("ok");
  setTimeout(() => {
    btn.textContent = before;
    btn.classList.remove("ok");
  }, 1400);
}

el.share.addEventListener("click", async () => {
  await navigator.clipboard.writeText(location.href);
  flashCopied(el.share);
});

/** Watch-only link for this room. Arrives with `welcome`; editors only. */
let watchUrl: string | null = null;

el.watch.addEventListener("click", async () => {
  if (!watchUrl) return;
  await navigator.clipboard.writeText(watchUrl);
  flashCopied(el.watch);
});

el.title.addEventListener("input", () => send({ t: "title", title: el.title.value }));

el.me.addEventListener("click", () => {
  const next = prompt("Your name in this room", store.name);
  if (!next?.trim()) return;
  store.name = next.trim().slice(0, 24);
  ws?.close();
});

// Changing only the fragment does not reload the page, so following a room
// link in an already-open tab would silently keep you in the old room.
window.addEventListener("hashchange", () => location.reload());

window.addEventListener("resize", () => {
  measure();
  drawCarets();
});

// A watch-only tab looks watch-only before the first byte arrives: the brief
// and title are frozen, the composer and Run are gone. The server enforces
// all of it regardless — this is presentation, not the lock.
if (SPECTATING) {
  document.body.classList.add("spectating");
  el.brief.readOnly = true;
  el.title.readOnly = true;
  el.composer.disabled = true;
  el.composer.placeholder = "you are watching — read only";
}

measure();
connect();
