import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { z } from "zod";

loadDotenv({ path: resolve(process.cwd(), "../../.env"), quiet: true });
loadDotenv({ path: resolve(process.cwd(), ".env"), quiet: true });

const environmentSchema = z.object({
  ANTHROPIC_API_KEY: z.string().optional(),
  CORS_ORIGIN: z.string().default("*"),
  CREDENTIAL_ENCRYPTION_KEY: z.string().min(16).default("development-credential-key-change-me"),
  DASHBOARD_URL: z.string().url().default("http://localhost:3002"),
  DATABASE_URL: z.string().url(),
  DEV_API_KEY: z.string().min(1).default("dev-key"),
  GEMINI_API_KEY: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  OPENAI_API_KEY: z.string().optional(),
  PADDLE_ENVIRONMENT: z.enum(["sandbox", "production"]).default("sandbox"),
  PADDLE_API_KEY: z.string().optional(),
  PADDLE_CLIENT_TOKEN: z.string().optional(),
  PADDLE_WEBHOOK_SECRET: z.string().optional(),
  PORT: z.coerce.number().int().positive().default(3000),
  PROVIDER_MODE: z.enum(["mock", "live"]).default("mock"),
  PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(3600),
  REQUEST_BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(1_048_576),
  ROUTEMIND_API_URL: z.string().url().default("http://localhost:3000"),
  ROUTER_LLM_ENABLED: z.coerce.boolean().default(true),
  ROUTER_LLM_MAX_TOKENS: z.coerce.number().int().positive().default(300),
  ROUTER_LLM_MODEL: z.string().min(1).default("gpt-4o-mini"),
  REDIS_URL: z.string().url(),
  SESSION_SECRET: z.string().min(16).default("development-session-secret-change-me"),
});

type ResolvedApiConfig = z.infer<typeof environmentSchema>;
type HardeningConfigKeys =
  | "CORS_ORIGIN"
  | "DASHBOARD_URL"
  | "RATE_LIMIT_MAX_REQUESTS"
  | "RATE_LIMIT_WINDOW_SECONDS"
  | "REQUEST_BODY_LIMIT_BYTES"
  | "ROUTEMIND_API_URL";

export type ApiConfig = Omit<ResolvedApiConfig, HardeningConfigKeys> &
  Partial<Pick<ResolvedApiConfig, HardeningConfigKeys>>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ResolvedApiConfig {
  const config = environmentSchema.parse(env);
  validateProductionConfig(config);
  return config;
}

function validateProductionConfig(config: ApiConfig): void {
  if (config.NODE_ENV !== "production") {
    return;
  }

  const missing: string[] = [];
  if (config.CREDENTIAL_ENCRYPTION_KEY === "development-credential-key-change-me") {
    missing.push("CREDENTIAL_ENCRYPTION_KEY");
  }
  if (config.SESSION_SECRET === "development-session-secret-change-me") {
    missing.push("SESSION_SECRET");
  }
  if (config.DEV_API_KEY === "dev-key") {
    missing.push("DEV_API_KEY");
  }
  if (config.PROVIDER_MODE === "live") {
    const hasProviderKey = Boolean(
      config.OPENAI_API_KEY ||
      config.ANTHROPIC_API_KEY ||
      config.GEMINI_API_KEY ||
      config.GROQ_API_KEY,
    );
    if (!hasProviderKey) {
      missing.push("at least one provider API key");
    }
  }
  if (config.PADDLE_ENVIRONMENT === "production") {
    if (!config.PADDLE_API_KEY) missing.push("PADDLE_API_KEY");
    if (!config.PADDLE_CLIENT_TOKEN) missing.push("PADDLE_CLIENT_TOKEN");
    if (!config.PADDLE_WEBHOOK_SECRET) missing.push("PADDLE_WEBHOOK_SECRET");
  }

  if (missing.length > 0) {
    throw new Error(`Missing production configuration: ${missing.join(", ")}`);
  }
}
