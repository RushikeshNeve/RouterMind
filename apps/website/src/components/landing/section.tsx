import clsx from "clsx";
import type { ReactNode } from "react";
import { FadeIn } from "./motion";

export function Section({
  id,
  eyebrow,
  title,
  description,
  children,
  className,
}: {
  readonly id?: string;
  readonly eyebrow?: string;
  readonly title?: string;
  readonly description?: string;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <section id={id} className={clsx("px-6 py-20 sm:py-24 lg:px-8", className)}>
      <div className="mx-auto max-w-7xl">
        {title ? (
          <FadeIn className="mx-auto mb-12 max-w-3xl text-center">
            {eyebrow ? <p className="mb-3 text-sm font-semibold text-blue-600">{eyebrow}</p> : null}
            <h2 className="text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
              {title}
            </h2>
            {description ? (
              <p className="mt-4 text-base leading-8 text-slate-600 sm:text-lg">{description}</p>
            ) : null}
          </FadeIn>
        ) : null}
        {children}
      </div>
    </section>
  );
}

export function ButtonLink({
  href,
  children,
  variant = "primary",
}: {
  readonly href: string;
  readonly children: ReactNode;
  readonly variant?: "primary" | "secondary" | "ghost";
}) {
  return (
    <a
      href={href}
      className={clsx(
        "inline-flex h-11 items-center justify-center rounded-lg px-5 text-sm font-semibold transition duration-200 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:ring-offset-2",
        variant === "primary" && "bg-blue-600 text-white shadow-sm hover:bg-blue-700",
        variant === "secondary" &&
          "border border-slate-200 bg-white text-slate-950 shadow-sm hover:border-slate-300 hover:bg-slate-50",
        variant === "ghost" && "text-slate-700 hover:bg-slate-100",
      )}
    >
      {children}
    </a>
  );
}
