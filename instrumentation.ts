/**
 * Next.js calls register() once when the server starts. We use it to run the
 * background scheduler (CloudWatch polling, alert dispatch, maintenance) in the
 * same process as the web app and API. Set SCHEDULER_ENABLED=false to turn it off.
 *
 * Keep the `process.env.NEXT_RUNTIME === "nodejs"` check inline: Next.js relies on
 * it to strip the Node-only scheduler (pg, AWS SDK) from the edge bundle.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.SCHEDULER_ENABLED !== "false") {
    const { startScheduler } = await import("./backend/scheduler");
    await startScheduler();
  }
}
