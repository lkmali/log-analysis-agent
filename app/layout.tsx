import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Claude SRE",
  description: "AI SRE platform: incidents, investigations, and pull requests.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      {/* Browser extensions (e.g. Grammarly) add attributes to <body> before React hydrates. */}
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
