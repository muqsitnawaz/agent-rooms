#!/usr/bin/env bun
/**
 * agent-rooms bridge — puts a REAL local coding agent into a shared room.
 *
 *   bun run bridge --room payments-refactor --host agent-room.<sub>.workers.dev \
 *     -- agents run claude "refactor the refund flow"
 *
 * It does three things:
 *   1. joins the room over the same WebSocket a human uses, with kind=agent
 *   2. spawns `agents run … --json --quiet` and translates its ndjson into feed events
 *   3. relays what the room says back — steers are injected into the live session,
 *      and the shared brief is written to disk so the agent can re-read it
 *
 * The point: your Claude Code session becomes something other people can watch
 * and steer, without changing how you run it.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Args = {
  room: string;
  host: string;
  name: string;
  briefPath: string;
  agentArgs: string[];
};

function parseArgs(argv: string[]): Args {
  const sep = argv.indexOf("--");
  const flags = sep === -1 ? argv : argv.slice(0, sep);
  const agentArgs = sep === -1 ? [] : argv.slice(sep + 1);
  const get = (name: string, fallback?: string) => {
    const i = flags.indexOf(`--${name}`);
    if (i !== -1 && flags[i + 1]) return flags[i + 1];
    if (fallback !== undefined) return fallback;
    console.error(`missing --${name}`);
    process.exit(1);
  };
  if (agentArgs.length === 0) {
    console.error("usage: bun run bridge --room <id> --host <host> -- agents run claude \"<prompt>\"");
    process.exit(1);
  }
  return {
    room: get("room")!,
    host: get("host", "localhost:8799")!,
    name: get("name", "claude · local")!,
    briefPath: get("brief", join(process.cwd(), ".agent-rooms", "brief.md"))!,
    agentArgs,
  };
}

const args = parseArgs(process.argv.slice(2));

/**
 * Cloudflare's `agents` npm package ships a bin ALSO named `agents`, and
 * `bun run` puts node_modules/.bin at the front of PATH — so a naive spawn of
 * "agents run claude …" hits the Cloudflare CLI instead and dies with
 * "Unknown arguments: run, claude". Drop local bin dirs so the child gets the
 * real agents-cli from the host PATH.
 */
const spawnEnv = {
  ...process.env,
  PATH: (process.env.PATH ?? "").split(":").filter((d) => !d.includes("node_modules/.bin")).join(":"),
};
const secure = !args.host.startsWith("localhost") && !args.host.startsWith("127.");
const wsUrl = `${secure ? "wss" : "ws"}://${args.host}/agents/room-agent/${args.room}` +
  `?as=${encodeURIComponent(args.name)}&kind=agent`;

const ws = new WebSocket(wsUrl);
let ready = false;
const queue: string[] = [];

function post(msg: unknown) {
  const s = JSON.stringify(msg);
  if (ready) ws.send(s);
  else queue.push(s);
}

function event(kind: "say" | "tool" | "system" | "edit", body: string) {
  if (!body.trim()) return;
  post({ t: "event", kind, body: body.trim().slice(0, 4000) });
}

ws.addEventListener("open", () => {
  ready = true;
  for (const q of queue.splice(0)) ws.send(q);
  console.log(`[bridge] joined ${args.room} at ${args.host} as "${args.name}"`);
  event("system", `bridged: ${args.agentArgs.join(" ")}`);
  spawnAgent();
});

ws.addEventListener("close", () => console.log("[bridge] room closed the socket"));
ws.addEventListener("error", (e) => console.error("[bridge] socket error", e));

/**
 * The room talks back. Steers go into the running session; brief edits are
 * mirrored to disk so the agent can re-read them mid-task.
 */
ws.addEventListener("message", (ev) => {
  let msg: { t: string; event?: { kind: string; actor: string; body: string } };
  try {
    msg = JSON.parse(String(ev.data));
  } catch {
    return;
  }
  if (msg.t === "event" && msg.event?.kind === "steer") {
    const { actor, body } = msg.event;
    console.log(`[bridge] steer from ${actor}: ${body}`);
    injectSteer(`${actor} (from the room): ${body}`);
  }
});

/** Mirror the room's brief to disk on a slow timer so the agent can read it. */
async function mirrorBrief() {
  try {
    const res = await fetch(`${secure ? "https" : "http"}://${args.host}/agents/room-agent/${args.room}/export`);
    if (!res.ok) return;
    const { brief } = (await res.json()) as { brief: string };
    mkdirSync(join(args.briefPath, ".."), { recursive: true });
    writeFileSync(args.briefPath, brief);
  } catch {
    // A failed mirror is not fatal — the run continues without it.
  }
}

let sessionId: string | null = null;

/**
 * Deliver a steer to the local agent. Two paths, because only one of them
 * works for any given run:
 *
 *   1. `agents sessions inject` types into the terminal a session lives in.
 *      That needs a tmux pane, so it only works when the bridge is attached to
 *      an interactive session — NOT to the headless run we spawn ourselves.
 *   2. Appending to the mirrored steers file, which the agent re-reads. This
 *      always works, and is the path the spawned run actually uses.
 *
 * Both are attempted; the room is told which one landed rather than being told
 * "delivered" when nothing was.
 */
function injectSteer(text: string) {
  const steersPath = join(args.briefPath, "..", "steers.md");
  try {
    mkdirSync(join(args.briefPath, ".."), { recursive: true });
    appendFileSync(steersPath, `- ${text}\n`);
  } catch {
    event("system", `steer could not be written to ${steersPath}`);
    return;
  }

  const session = sessionId;
  if (!session) {
    event("system", `steer queued in ${steersPath}`);
    return;
  }
  const p = Bun.spawn(["agents", "sessions", "inject", session, text], { stdout: "pipe", stderr: "pipe", env: spawnEnv });
  p.exited.then((code) => {
    event(
      "system",
      code === 0
        ? `steer injected into session ${session.slice(0, 8)}`
        : `steer queued in ${steersPath} (no terminal to inject into)`,
    );
  });
}

/** Pull the human-readable bits out of one ndjson line of `agents run --json`. */
function translate(line: string) {
  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(line);
  } catch {
    return;
  }

  if (typeof ev.session_id === "string" && !sessionId) sessionId = ev.session_id;

  const type = ev.type as string;

  if (type === "assistant") {
    const message = ev.message as { content?: Array<Record<string, unknown>> } | undefined;
    for (const part of message?.content ?? []) {
      if (part.type === "text" && typeof part.text === "string") event("say", part.text);
      if (part.type === "tool_use") {
        const input = part.input as Record<string, unknown> | undefined;
        const target =
          (input?.file_path as string) ?? (input?.path as string) ?? (input?.command as string) ??
          (input?.pattern as string) ?? (input?.description as string) ?? "";
        event("tool", `${part.name}${target ? `  ${String(target).slice(0, 160)}` : ""}`);
      }
    }
    return;
  }

  if (type === "result") {
    const usage = ev.usage as { input_tokens?: number; output_tokens?: number } | undefined;
    const cost = typeof ev.total_cost_usd === "number" ? ` · $${ev.total_cost_usd.toFixed(3)}` : "";
    const turns = typeof ev.num_turns === "number" ? `${ev.num_turns} turns` : "done";
    event("system", `run finished — ${turns}${cost}${usage?.output_tokens ? ` · ${usage.output_tokens} out` : ""}`);
  }
}

function spawnAgent() {
  const argv = [...args.agentArgs];
  if (!argv.includes("--json")) argv.push("--json");
  if (!argv.includes("--quiet")) argv.push("--quiet");

  console.log(`[bridge] $ ${argv.join(" ")}`);
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", env: spawnEnv });

  const mirror = setInterval(mirrorBrief, 4000);
  void mirrorBrief();

  // stderr must be drained, not just piped: an undrained pipe fills its buffer
  // and stalls the child. Keep the tail so a non-zero exit can say WHY.
  let stderrTail = "";
  (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stderr) {
      const text = decoder.decode(chunk, { stream: true });
      process.stderr.write(text);
      stderrTail = (stderrTail + text).slice(-1200);
    }
  })();

  (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of proc.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) translate(line);
    }
    if (buffer.trim()) translate(buffer);

    const code = await proc.exited;
    clearInterval(mirror);
    if (code === 0) {
      event("system", "local agent finished");
    } else {
      const why = stderrTail.trim().split("\n").filter(Boolean).slice(-3).join(" · ");
      event("system", `local agent exited ${code}${why ? ` — ${why}` : ""}`);
    }
    setTimeout(() => ws.close(), 500);
  })();
}
