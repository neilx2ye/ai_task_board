/**
 * Runs once when the Node.js server starts. The hosted pg_cron scheduler is
 * replaced by an in-process maintenance interval for the local PostgreSQL
 * deployment.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startMaintenance } = await import("@/lib/maintenance");
    startMaintenance();
  }
}
