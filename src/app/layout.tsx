import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "EMA — Assistant administratif email",
  description: "Agent administratif IA pour une boîte Outlook professionnelle",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
