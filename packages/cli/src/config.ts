import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_BASE_URL = "http://localhost:3000";

export interface RouteMindCliConfig {
  readonly apiKey?: string;
  readonly baseUrl: string;
}

export function getConfigPath(homeDir = homedir()): string {
  return join(homeDir, ".routemind", "config.json");
}

export async function loadConfig(configPath = getConfigPath()): Promise<RouteMindCliConfig> {
  try {
    const rawConfig = await readFile(configPath, "utf8");
    const parsed = JSON.parse(rawConfig) as Partial<RouteMindCliConfig>;

    return {
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : undefined,
      baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : DEFAULT_BASE_URL,
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return { baseUrl: DEFAULT_BASE_URL };
    }

    throw error;
  }
}

export async function saveConfig(
  config: RouteMindCliConfig,
  configPath = getConfigPath(),
): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(
    configPath,
    `${JSON.stringify({ apiKey: config.apiKey, baseUrl: config.baseUrl }, null, 2)}\n`,
    "utf8",
  );
}

export function maskApiKey(apiKey?: string): string {
  if (!apiKey) {
    return "not set";
  }

  if (apiKey.length <= 8) {
    return `${apiKey.slice(0, 2)}...${apiKey.slice(-2)}`;
  }

  return `${apiKey.slice(0, 7)}...${apiKey.slice(-4)}`;
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: string }).code === "ENOENT"
  );
}
