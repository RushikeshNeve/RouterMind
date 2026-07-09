import {
  Activity,
  BarChart3,
  Boxes,
  Braces,
  Cable,
  Code2,
  Database,
  Gauge,
  GitBranch,
  HeartPulse,
  KeyRound,
  LayoutDashboard,
  LockKeyhole,
  Network,
  Package,
  Radar,
  Route,
  Server,
  ShieldCheck,
  Terminal,
  WalletCards,
} from "lucide-react";

export const links = {
  dashboard: "https://router-mind-frlqw1ilb-rushikeshneves-projects.vercel.app",
  backend: "https://routermind.onrender.com",
  github: "https://github.com/RushikeshNeve/RouterMind",
  sdk: "https://www.npmjs.com/package/@routemind/sdk",
  cli: "https://www.npmjs.com/package/@routemind/cli",
  docs: "https://github.com/RushikeshNeve/RouterMind#readme",
  authorGithub: "https://github.com/RushikeshNeve",
  linkedIn: "https://www.linkedin.com/in/rushikesh-neve-a96744212/",
};

export const trustStack = [
  "Node.js",
  "TypeScript",
  "Fastify",
  "Next.js",
  "PostgreSQL",
  "Redis",
  "Docker",
];

export const features = [
  {
    title: "AI Gateway",
    description: "A single OpenAI-compatible gateway for application LLM traffic.",
    icon: Network,
  },
  {
    title: "LLM Routing",
    description: "Select models by cost, latency, health, capability, and policies.",
    icon: Route,
  },
  {
    title: "Provider Failover",
    description: "Retry transient failures and fall back across healthy providers.",
    icon: GitBranch,
  },
  {
    title: "Semantic Cache",
    description: "Reduce duplicate requests and repeated spend with response caching.",
    icon: Database,
  },
  {
    title: "Prompt Firewall",
    description: "Inspect prompts for secrets, injection, risky content, and policies.",
    icon: ShieldCheck,
  },
  {
    title: "Cost Guardrails",
    description: "Enforce budget, quota, cost-tier, and request-level spend controls.",
    icon: WalletCards,
  },
  {
    title: "Analytics",
    description: "Track spend, latency, routing, provider health, and request volume.",
    icon: BarChart3,
  },
  {
    title: "SDK",
    description: "Use a typed TypeScript client for chat, analytics, and health APIs.",
    icon: Code2,
  },
  {
    title: "CLI",
    description: "Send prompts, inspect health, and view analytics from the terminal.",
    icon: Terminal,
  },
  {
    title: "Dashboard",
    description: "Operate RouteMind through a focused Next.js control surface.",
    icon: LayoutDashboard,
  },
  {
    title: "OpenAI Compatibility",
    description: "Point existing OpenAI SDK clients at RouteMind with a base URL.",
    icon: Braces,
  },
  {
    title: "Circuit Breakers",
    description: "Protect applications from degraded providers and repeated failures.",
    icon: HeartPulse,
  },
];

export const architectureSteps = [
  { label: "Client", icon: Cable },
  { label: "API Gateway", icon: Server },
  { label: "Authentication", icon: KeyRound },
  { label: "Prompt Firewall", icon: LockKeyhole },
  { label: "Cache", icon: Database },
  { label: "Routing Engine", icon: Radar },
  { label: "Budget Guardrails", icon: WalletCards },
  { label: "Resilience", icon: Activity },
  { label: "Provider Adapters", icon: Boxes },
];

export const providers = ["OpenAI", "Claude", "Gemini", "Groq"];

export const codeExamples = {
  "OpenAI SDK": `import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.ROUTEMIND_API_KEY,
  baseURL: "https://routermind.onrender.com/v1"
});

await client.chat.completions.create({
  model: "auto",
  messages: [{ role: "user", content: "Explain microservices" }]
});`,
  "RouteMind SDK": `import { RouteMind } from "@routemind/sdk";

const client = new RouteMind({
  apiKey: process.env.ROUTEMIND_API_KEY,
  baseUrl: "https://routermind.onrender.com"
});

const response = await client.chat.completions.create({
  model: "auto",
  messages: [{ role: "user", content: "Route this request" }]
});`,
  "REST API": `curl -X POST https://routermind.onrender.com/v1/chat/completions \\
  -H "content-type: application/json" \\
  -H "Authorization: Bearer $ROUTEMIND_API_KEY" \\
  -d '{
    "model": "auto",
    "messages": [
      { "role": "user", "content": "Summarize this incident" }
    ]
  }'`,
  CLI: `npm install -g @routemind/cli

routemind --base-url https://routermind.onrender.com login
routemind chat "Explain Kubernetes"
routemind analytics`,
};

export const liveLinks = [
  { title: "Dashboard", href: links.dashboard, icon: LayoutDashboard },
  { title: "Backend API", href: links.backend, icon: Server },
  { title: "GitHub", href: links.github, icon: GitBranch },
  { title: "npm SDK", href: links.sdk, icon: Package },
  { title: "npm CLI", href: links.cli, icon: Terminal },
];

export const screenshots = [
  { title: "Dashboard", icon: LayoutDashboard },
  { title: "Analytics", icon: BarChart3 },
  { title: "Health", icon: Gauge },
  { title: "Providers", icon: Boxes },
];
