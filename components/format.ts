const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

export function timeAgo(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return rtf.format(seconds, "second");
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(seconds / 3600), "hour");
  return rtf.format(Math.round(seconds / 86400), "day");
}

export function formatNumber(n: number | string | null | undefined): string {
  return new Intl.NumberFormat("en").format(Number(n ?? 0));
}

export function formatUsd(n: number | string | null | undefined): string {
  return new Intl.NumberFormat("en", { style: "currency", currency: "USD" }).format(Number(n ?? 0));
}

export const humanize = (s: string) => s.replace(/_/g, " ");
