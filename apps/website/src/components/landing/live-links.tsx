import { ArrowUpRight } from "lucide-react";
import { liveLinks } from "./data";
import { FadeIn } from "./motion";
import { Section } from "./section";

export function LiveLinks() {
  return (
    <Section
      title="Live project links"
      description="Explore the deployed dashboard, backend API, source code, and npm packages."
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {liveLinks.map((item, index) => {
          const Icon = item.icon;
          return (
            <FadeIn key={item.title} delay={index * 0.04}>
              <a
                href={item.href}
                className="group flex h-full flex-col justify-between rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:-translate-y-1 hover:border-blue-200 hover:shadow-lg"
              >
                <div className="flex items-center justify-between">
                  <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
                    <Icon className="h-5 w-5" />
                  </span>
                  <ArrowUpRight className="h-4 w-4 text-slate-400 transition group-hover:text-blue-600" />
                </div>
                <div className="mt-8">
                  <h3 className="text-sm font-semibold text-slate-950">{item.title}</h3>
                  <p className="mt-2 truncate text-xs text-slate-500">{item.href}</p>
                </div>
              </a>
            </FadeIn>
          );
        })}
      </div>
    </Section>
  );
}
