import { features } from "./data";
import { FadeIn } from "./motion";
import { Section } from "./section";

export function Features() {
  return (
    <Section
      id="features"
      title="Everything you need to operate LLM traffic"
      description="RouteMind brings routing, security, cost control, and observability into one clean gateway layer."
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {features.map((feature, index) => {
          const Icon = feature.icon;
          return (
            <FadeIn key={feature.title} delay={Math.min(index * 0.025, 0.18)}>
              <article className="h-full rounded-xl border border-slate-200 bg-white p-6 shadow-sm transition duration-200 hover:-translate-y-1 hover:shadow-lg">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
                  <Icon className="h-5 w-5" />
                </div>
                <h3 className="mt-5 text-base font-semibold text-slate-950">{feature.title}</h3>
                <p className="mt-2 text-sm leading-6 text-slate-600">{feature.description}</p>
              </article>
            </FadeIn>
          );
        })}
      </div>
    </Section>
  );
}
