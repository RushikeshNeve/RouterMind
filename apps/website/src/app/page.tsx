import { Architecture } from "../components/landing/architecture";
import { CodeExamples } from "../components/landing/code-examples";
import { CTA } from "../components/landing/cta";
import { Features } from "../components/landing/features";
import { Footer } from "../components/landing/footer";
import { Hero } from "../components/landing/hero";
import { HowItWorks } from "../components/landing/how-it-works";
import { LiveLinks } from "../components/landing/live-links";
import { Navbar } from "../components/landing/navbar";
import { Screenshots } from "../components/landing/screenshots";
import { TrustSection } from "../components/landing/trust-section";
import { Playground } from "../components/playground/Playground";

export default function HomePage() {
  return (
    <main className="min-h-screen bg-white text-slate-950">
      <Navbar />
      <Hero />
      <TrustSection />
      <Features />
      <Playground />
      <Architecture />
      <HowItWorks />
      <CodeExamples />
      <LiveLinks />
      <Screenshots />
      <CTA />
      <Footer />
    </main>
  );
}
