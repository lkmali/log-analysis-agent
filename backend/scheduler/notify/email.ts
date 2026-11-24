import nodemailer from "nodemailer";
import type { AlertMessage, Notifier } from "./types";

export function emailNotifier(smtpUrl: string, from: string, to: string): Notifier {
  const transport = nodemailer.createTransport(smtpUrl);
  return {
    name: "email",
    async send(a: AlertMessage) {
      await transport.sendMail({
        from,
        to,
        subject: `[${a.severity.toUpperCase()}] ${a.title}`,
        text: `${a.title}\n\n${a.body ?? ""}\n\nOrganization: ${a.organizationName}\nOccurrences: ${a.occurrences}\n${a.url}\n`,
      });
    },
  };
}
