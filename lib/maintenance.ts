import "server-only";

import { query } from "@/lib/db";

const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
let started = false;

/**
 * Single-process replacement for the hosted pg_cron job. The deployment runs
 * one Next.js instance under systemd, so a plain interval is sufficient.
 */
export function startMaintenance(): void {
  if (started || process.env.NODE_ENV === "test") return;
  started = true;

  const run = () => {
    void query(`select public.cleanup_expired_idempotency_records(500)`)
      .catch(() => undefined);
    void query(
      `delete from auth.sessions
       where expires_at < now() - interval '7 days'`,
    ).catch(() => undefined);
  };

  run();
  setInterval(run, CLEANUP_INTERVAL_MS);
}
