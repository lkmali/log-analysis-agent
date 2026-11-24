import { withTransaction, type AlertKind, type Severity } from "@/backend/db";
import type { Config } from "../config";
import { errorMessage } from "../logger";
import { emailNotifier } from "../notify/email";
import { slackNotifier } from "../notify/slack";
import type { Notifier } from "../notify/types";
import type { JobContext } from "../runner";

const MAX_ATTEMPTS = 6;

/**
 * Sends newly opened alerts (severity >= ALERT_NOTIFY_MIN_SEVERITY) to every
 * configured channel. Failed sends retry with exponential backoff.
 */
export function notifiersFor(cfg: Config): Notifier[] {
  const notifiers: Notifier[] = [];
  if (cfg.SLACK_WEBHOOK_URL) notifiers.push(slackNotifier(cfg.SLACK_WEBHOOK_URL));
  if (cfg.SMTP_URL && cfg.ALERT_EMAIL_FROM && cfg.ALERT_EMAIL_TO) {
    notifiers.push(emailNotifier(cfg.SMTP_URL, cfg.ALERT_EMAIL_FROM, cfg.ALERT_EMAIL_TO));
  }
  return notifiers;
}

export function alertDispatchJob() {
  return async function run({ pool, log, cfg }: JobContext) {
    const notifiers = notifiersFor(cfg);
    if (notifiers.length === 0) return { skipped: "no channels configured (Settings → Alerts)" };

    return withTransaction(pool, async (c) => {
      const { rows } = await c.query<{
        id: string; organization_id: string; kind: AlertKind; severity: Severity; title: string;
        body: string | null; occurrences: number; notify_attempts: number; organization_name: string;
      }>(
        `select a.id, a.organization_id, a.kind, a.severity, a.title, a.body, a.occurrences, a.notify_attempts,
                o.name as organization_name
           from public.alerts a join public.organizations o on o.id = a.organization_id
          where a.notified_at is null and a.status = 'open'
            and a.notify_attempts < $1
            and (a.next_notify_at is null or a.next_notify_at <= now())
            and a.severity >= $2::public.severity
          order by a.severity desc, a.first_seen
          limit 50
          for update of a skip locked`,
        [MAX_ATTEMPTS, cfg.ALERT_NOTIFY_MIN_SEVERITY],
      );

      let sent = 0;
      let failed = 0;
      for (const a of rows) {
        const message = {
          id: a.id, kind: a.kind, severity: a.severity, title: a.title, body: a.body,
          occurrences: a.occurrences, organizationName: a.organization_name,
          url: `${cfg.APP_BASE_URL.replace(/\/$/, "")}/alerts`,
        };
        let allOk = true;
        for (const n of notifiers) {
          try {
            await n.send(message);
            await c.query(
              "insert into public.alert_deliveries (organization_id, alert_id, channel, succeeded) values ($1, $2, $3, true)",
              [a.organization_id, a.id, n.name],
            );
          } catch (err) {
            allOk = false;
            log.warn("alert delivery failed", { alertId: a.id, channel: n.name, error: errorMessage(err) });
            await c.query(
              "insert into public.alert_deliveries (organization_id, alert_id, channel, succeeded, error) values ($1, $2, $3, false, $4)",
              [a.organization_id, a.id, n.name, errorMessage(err).slice(0, 500)],
            );
          }
        }
        if (allOk) {
          sent++;
          await c.query("update public.alerts set notified_at = now() where id = $1", [a.id]);
        } else {
          failed++;
          // 1, 2, 4, 8, 16 minutes ...
          await c.query(
            `update public.alerts set notify_attempts = notify_attempts + 1,
                    next_notify_at = now() + make_interval(mins => power(2, notify_attempts)::int)
              where id = $1`,
            [a.id],
          );
        }
      }
      return { pending: rows.length, sent, failed };
    });
  };
}
