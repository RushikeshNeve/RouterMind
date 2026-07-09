import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "RouteMind Dashboard",
  description: "Developer dashboard for RouteMind AI Gateway analytics and operations.",
};

export default function RootLayout({ children }: { readonly children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
