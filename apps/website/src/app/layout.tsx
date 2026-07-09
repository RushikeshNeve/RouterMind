import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://router-mind-frlqw1ilb-rushikeshneves-projects.vercel.app"),
  title: {
    default: "RouteMind - Enterprise AI Gateway",
    template: "%s | RouteMind",
  },
  description:
    "RouteMind is an enterprise AI Gateway for intelligent LLM routing across OpenAI, Anthropic, Gemini, and Groq.",
  keywords: [
    "RouteMind",
    "AI Gateway",
    "LLM routing",
    "OpenAI compatible API",
    "Anthropic",
    "Gemini",
    "Groq",
    "TypeScript SDK",
  ],
  authors: [{ name: "Rushikesh Neve", url: "https://github.com/RushikeshNeve" }],
  creator: "Rushikesh Neve",
  openGraph: {
    title: "RouteMind - Enterprise AI Gateway",
    description: "One API for intelligent routing across OpenAI, Anthropic, Gemini, and Groq.",
    url: "https://router-mind-frlqw1ilb-rushikeshneves-projects.vercel.app",
    siteName: "RouteMind",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "RouteMind - Enterprise AI Gateway",
    description: "One API for intelligent routing across OpenAI, Anthropic, Gemini, and Groq.",
  },
  icons: {
    icon: "/routemind-icon.svg",
    apple: "/routemind-icon.svg",
  },
};

export default function RootLayout({ children }: { readonly children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
