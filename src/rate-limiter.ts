/**
 * One Durable Object per client IP, used as a fixed-window run limiter.
 *
 * This is the canonical Durable Object shape, and the reason it works well is
 * the same reason a GLOBAL limiter would not: keyed by IP, each limiter is
 * created near the requester and only ever serves that requester, so it adds no
 * contention and effectively no latency. A single global limiter object would
 * funnel every request on the planet through one thread.
 *
 * Why it exists: the room's model key is billed to whoever deployed the Worker,
 * and any visitor with a room link can press Run. The per-room cap bounds one
 * room; this bounds one person opening many rooms.
 */
import { DurableObject } from "cloudflare:workers";

export type RunAllowance = { ok: boolean; remaining: number; retryAfterSeconds: number };

const WINDOW_MS = 60 * 60 * 1000;

export class RunLimiter extends DurableObject {
  /**
   * Consume one run for this IP. Fixed window: simpler than a token bucket and
   * the failure mode (a burst at a window edge) is harmless for this purpose.
   */
  consume(limit: number): RunAllowance {
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS window (id INTEGER PRIMARY KEY, started_at INTEGER NOT NULL, used INTEGER NOT NULL)`,
    );
    const now = Date.now();
    const rows = [
      ...this.ctx.storage.sql.exec<{ started_at: number; used: number }>(
        `SELECT started_at, used FROM window WHERE id = 1`,
      ),
    ];
    let startedAt = rows[0]?.started_at ?? 0;
    let used = rows[0]?.used ?? 0;

    if (now - startedAt >= WINDOW_MS) {
      startedAt = now;
      used = 0;
    }
    if (used >= limit) {
      return {
        ok: false,
        remaining: 0,
        retryAfterSeconds: Math.ceil((startedAt + WINDOW_MS - now) / 1000),
      };
    }
    used += 1;
    this.ctx.storage.sql.exec(
      `INSERT INTO window (id, started_at, used) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET started_at = excluded.started_at, used = excluded.used`,
      startedAt,
      used,
    );
    return { ok: true, remaining: limit - used, retryAfterSeconds: 0 };
  }
}
