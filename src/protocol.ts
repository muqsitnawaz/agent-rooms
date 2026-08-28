/**
 * The room wire protocol.
 *
 * One WebSocket carries three independent streams, discriminated by `t`:
 *   - Yjs document sync   (`sync1` / `sync2` / `update`)  — the shared brief
 *   - presence            (`hello` / `peers` / `cursor`)  — who is here, and where their caret is
 *   - the activity feed   (`event` / `delta` / `run`)     — what the agents are doing
 *
 * Humans and agents speak the SAME protocol. A bridged `agents run claude`
 * connects with `kind=agent` and is otherwise an ordinary participant: it gets
 * a colour, a row in the presence rail, and a cursor in the document.
 */

export type PeerKind = "human" | "agent";

export type Peer = {
  id: string;
  name: string;
  color: string;
  kind: PeerKind;
  /** Absolute caret offset into the brief, or null when the peer is not in the document. */
  cursor: number | null;
  /** Short label rendered on the caret flag, e.g. "reading". Agents only. */
  activity: string | null;
};

/** An entry in the activity feed. Persisted in the room's SQLite. */
export type RoomEvent = {
  id: number;
  ts: number;
  /** Who produced it — peer name, not id, so it survives reconnects. */
  actor: string;
  color: string;
  /** Human or agent. Carried explicitly so the UI never has to infer it from a colour. */
  by: PeerKind;
  kind: "say" | "tool" | "steer" | "join" | "system" | "edit";
  body: string;
};

/** Client -> server. */
export type ClientMessage =
  | { t: "hello"; name: string; color: string; kind: PeerKind }
  | { t: "sync1"; sv: string }
  | { t: "update"; update: string }
  | { t: "cursor"; cursor: number | null; activity?: string | null }
  | { t: "steer"; text: string }
  | { t: "run"; prompt: string }
  | { t: "stop" }
  | { t: "event"; kind: RoomEvent["kind"]; body: string }
  | { t: "title"; title: string };

/** Server -> client. */
export type ServerMessage =
  | { t: "welcome"; you: Peer; title: string; running: boolean; events: RoomEvent[] }
  | { t: "sync1"; sv: string }
  | { t: "sync2"; update: string }
  | { t: "update"; update: string }
  | { t: "peers"; peers: Peer[] }
  | { t: "event"; event: RoomEvent }
  /** Token delta from a streaming agent — appended to the tail of the feed. */
  | { t: "delta"; actor: string; color: string; by: PeerKind; text: string }
  | { t: "running"; running: boolean; runner: string | null }
  | { t: "title"; title: string }
  | { t: "error"; message: string };

/** Palette for participants. Index 0 is reserved for the cloud agent. */
export const COLORS = [
  "#a3e635", // lime — the agent
  "#38bdf8", // sky
  "#f472b6", // pink
  "#fbbf24", // amber
  "#c084fc", // violet
  "#34d399", // emerald
  "#fb7185", // rose
  "#60a5fa", // blue
];

export const AGENT_COLOR = COLORS[0];

export function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function b64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
