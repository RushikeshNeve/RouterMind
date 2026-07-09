import { GitBranch } from "lucide-react";
import { links } from "./data";
import { FadeIn } from "./motion";
import { ButtonLink } from "./section";

export function CTA() {
  return (
    <section id="get-started" className="px-6 py-20 lg:px-8">
      <FadeIn className="mx-auto max-w-5xl rounded-2xl border border-slate-200 bg-slate-950 px-6 py-14 text-center shadow-xl sm:px-10">
        <h2 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
          Ready to build with RouteMind?
        </h2>
        <p className="mx-auto mt-4 max-w-2xl text-base leading-7 text-slate-300">
          Start with the hosted API, inspect the dashboard, or clone the open-source repository and
          run the full gateway locally.
        </p>
        <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
          <ButtonLink href={links.dashboard}>Get Started</ButtonLink>
          <ButtonLink href={links.github} variant="secondary">
            <GitBranch className="mr-2 h-4 w-4" />
            View GitHub
          </ButtonLink>
        </div>
      </FadeIn>
    </section>
  );
}
