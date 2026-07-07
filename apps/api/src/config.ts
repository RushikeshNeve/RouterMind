import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { z } from "zod";

loadDotenv({ path: resolve(process.cwd(), "../../.env"), quiet: true });
loadDotenv({ path: resolve(process.cwd(), ".env"), quiet: true });

const environmentSchema = z.object({
  ANTHROPIC_API_KEY: z.string().optional(),
  CREDENTIAL_ENCRYPTION_KEY: z.string().min(16).default("development-credential-key-change-me"),
  DATABASE_URL: z.string().url(),
  DEV_API_KEY: z.string().min(1).default("dev-key"),
  GEMINI_API_KEY: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  OPENAI_API_KEY: z.string().optional(),
  PORT: z.coerce.number().int().positive().default(3000),
  PROVIDER_MODE: z.enum(["mock", "live"]).default("mock"),
  PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  ROUTER_LLM_ENABLED: z.coerce.boolean().default(true),
  ROUTER_LLM_MAX_TOKENS: z.coerce.number().int().positive().default(300),
  ROUTER_LLM_MODEL: z.string().min(1).default("gpt-4o-mini"),
  REDIS_URL: z.string().url(),
});

export type ApiConfig = z.infer<typeof environmentSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  return environmentSchema.parse(env);
}
