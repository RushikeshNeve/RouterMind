"use client";

import { Menu, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { links } from "./data";
import { ButtonLink } from "./section";

const nav = [
  { label: "Features", href: "#features" },
  { label: "Pricing", href: "#pricing" },
  { label: "Data & Trust", href: "#data-handling" },
  { label: "Architecture", href: "#architecture" },
  { label: "Documentation", href: links.docs },
  { label: "SDK", href: links.sdk },
  { label: "CLI", href: links.cli },
  { label: "GitHub", href: links.github },
  { label: "Dashboard", href: links.dashboard },
];

type ScrollWindow = {
  readonly scrollY: number;
  readonly addEventListener: (
    type: "scroll",
    listener: () => void,
    options?: { readonly passive?: boolean },
  ) => void;
  readonly removeEventListener: (type: "scroll", listener: () => void) => void;
};

export function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const scrollWindow = globalThis as typeof globalThis & ScrollWindow;
    const onScroll = () => setScrolled(scrollWindow.scrollY > 8);
    onScroll();
    scrollWindow.addEventListener("scroll", onScroll, { passive: true });
    return () => scrollWindow.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={`fixed inset-x-0 top-0 z-50 border-b transition ${
        scrolled
          ? "border-slate-200 bg-white/88 shadow-sm backdrop-blur-xl"
          : "border-transparent bg-white/70 backdrop-blur-sm"
      }`}
    >
      <nav className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6 lg:px-8">
        <Link href="/" className="flex items-center gap-3" aria-label="RouteMind home">
          <img
            src="/routemind-icon.svg"
            alt=""
            aria-hidden="true"
            className="h-9 w-9 rounded-lg object-contain"
          />
          <span className="text-sm font-semibold tracking-tight text-slate-950">RouteMind</span>
        </Link>

        <div className="hidden items-center gap-7 lg:flex">
          {nav.map((item) => (
            <a
              key={item.label}
              href={item.href}
              className="text-sm font-medium text-slate-600 transition hover:text-slate-950"
            >
              {item.label}
            </a>
          ))}
        </div>

        <div className="hidden lg:block">
          <ButtonLink href="#get-started">Get Started</ButtonLink>
        </div>

        <button
          type="button"
          className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-slate-200 text-slate-700 lg:hidden"
          aria-label="Toggle navigation"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </nav>

      {open ? (
        <div className="border-t border-slate-200 bg-white px-6 py-4 lg:hidden">
          <div className="grid gap-3">
            {nav.map((item) => (
              <a
                key={item.label}
                href={item.href}
                className="rounded-lg px-2 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                onClick={() => setOpen(false)}
              >
                {item.label}
              </a>
            ))}
            <a
              href="#get-started"
              className="mt-2 rounded-lg bg-blue-600 px-4 py-3 text-center text-sm font-semibold text-white"
              onClick={() => setOpen(false)}
            >
              Get Started
            </a>
          </div>
        </div>
      ) : null}
    </header>
  );
}
