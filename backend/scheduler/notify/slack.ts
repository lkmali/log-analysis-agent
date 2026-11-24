import type { AlertMessage, Notifier } from "./types";

const EMOJI = { critical: ":rotating_light:", high: ":red_circle:", medium: ":large_orange_circle:", low: ":white_circle:" };

export function slackNotifier(webhookUrl: string): Notifier {
  return {
    name: "slack",
    async send(a: AlertMessage) {
      const text = `${EMOJI[a.severity]} [${a.severity.toUpperCase()}] ${a.title}`;
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({
          text,
          blocks: [
            { type: "section", text: { type: "mrkdwn", text: `*${text}*\n${a.organizationName}` } },
            ...(a.body ? [{ type: "section", text: { type: "mrkdwn", text: "```" + a.body.slice(0, 2800) + "```" } }] : []),
            { type: "context", elements: [{ type: "mrkdwn", text: `Occurrences: ${a.occurrences} · <${a.url}|Open in dashboard>` }] },
          ],
        }),
      });
      if (!res.ok) throw new Error(`Slack webhook returned ${res.status}`);
    },
  };
}
