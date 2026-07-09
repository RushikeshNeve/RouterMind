import { trustStack } from "./data";
import { FadeIn } from "./motion";

export function TrustSection() {
  return (
    <section className="border-y border-slate-200 bg-slate-50 px-6 py-8 lg:px-8">
      <FadeIn className="mx-auto flex max-w-7xl flex-col gap-5 sm:flex-row sm:items-center">
        <p className="text-sm font-semibold text-slate-500">Built using</p>
        <div className="flex flex-wrap gap-2">
          {trustStack.map((item) => (
            <span
              key={item}
              className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm"
            >
              {item}
            </span>
          ))}
        </div>
      </FadeIn>
    </section>
  );
}
