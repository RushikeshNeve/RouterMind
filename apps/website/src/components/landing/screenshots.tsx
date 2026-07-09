import { screenshots } from "./data";
import { FadeIn } from "./motion";
import { Section } from "./section";

export function Screenshots() {
  return (
    <Section
      className="bg-slate-50"
      title="Dashboard views"
      description="Placeholder cards for the production dashboard screenshots."
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {screenshots.map((item, index) => {
          const Icon = item.icon;
          return (
            <FadeIn key={item.title} delay={index * 0.05}>
              <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
                <div className="flex aspect-[4/3] items-center justify-center bg-[linear-gradient(135deg,#f8fafc,#eef2ff)]">
                  <div className="text-center">
                    <Icon className="mx-auto h-8 w-8 text-blue-600" />
                    <p className="mt-3 text-sm font-semibold text-slate-700">{item.title}</p>
                  </div>
                </div>
                <div className="border-t border-slate-200 px-4 py-3">
                  <p className="text-xs font-medium text-slate-500">
                    {item.title} screenshot placeholder
                  </p>
                </div>
              </div>
            </FadeIn>
          );
        })}
      </div>
    </Section>
  );
}
