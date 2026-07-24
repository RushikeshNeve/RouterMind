#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin as defaultStdin, stdout as defaultStdout } from "node:process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { Command } from "commander";
import ora from "ora";
import {
  RouteMind,
  RouteMindError,
  type AnalyticsSummary,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
  type ChatCompletionStream,
  type CircuitBreakerListResponse,
  type ProviderHealthResponse,
  type RouteMindClientOptions,
} from "@routemind/sdk";

import {
  DEFAULT_BASE_URL,
  getConfigPath,
  loadConfig,
  maskApiKey,
  saveConfig,
  type RouteMindCliConfig,
} from "./config.js";

export interface CliDependencies {
  readonly stdout?: OutputWriter;
  readonly stderr?: OutputWriter;
  readonly configPath?: string;
  readonly promptApiKey?: () => Promise<string>;
  readonly createClient?: (options: RouteMindClientOptions) => RouteMindClient;
  readonly spinner?: SpinnerFactory;
}

export interface OutputWriter {
  write(chunk: string): void;
}

export interface RouteMindClient {
  readonly chat: {
    readonly completions: {
      readonly create: RouteMind["chat"]["completions"]["create"];
    };
  };
  readonly health: {
    readonly providers: {
      readonly list: RouteMind["health"]["providers"]["list"];
    };
  };
  readonly analytics: {
    readonly summary: RouteMind["analytics"]["summary"];
  };
  readonly resilience: {
    readonly circuitBreakers: {
      readonly list: RouteMind["resilience"]["circuitBreakers"]["list"];
    };
  };
}

interface Spinner {
  readonly start: (text?: string) => Spinner;
  readonly succeed: (text?: string) => Spinner;
  readonly fail: (text?: string) => Spinner;
}

type SpinnerFactory = (text: string) => Spinner;

interface GlobalOptions {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly json?: boolean;
}

interface ChatOptions {
  readonly model?: string;
  readonly strategy?: "balanced" | "cost_first" | "quality_first" | "latency_first";
  readonly maxCostTier?: "low" | "medium" | "high";
  readonly maxEstimatedCostUsd?: string;
  readonly routingMode?: "rule_based" | "score_based" | "llm_assisted";
  readonly stream?: boolean;
}

const strategyMap = {
  balanced: "balanced",
  cost_first: "cost_optimized",
  quality_first: "quality_optimized",
  latency_first: "speed_optimized",
} as const;

export function createProgram(dependencies: CliDependencies = {}): Command {
  const stdout = dependencies.stdout ?? defaultStdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const configPath = dependencies.configPath ?? getConfigPath();
  const createClient = dependencies.createClient ?? ((options) => new RouteMind(options));
  const spinnerFactory = dependencies.spinner ?? createOraSpinner;
  const program = new Command();

  program
    .name("routemind")
    .description("Developer CLI for the RouteMind AI Gateway")
    .version("0.1.0")
    .option("--api-key <apiKey>", "RouteMind API key")
    .option("--base-url <url>", "RouteMind API base URL")
    .option("--json", "print raw JSON output");

  program
    .command("login")
    .description("store a RouteMind API key locally")
    .action(async () => {
      const globals = getGlobalOptions(program);
      const existingConfig = await loadConfig(configPath);
      const apiKey = globals.apiKey ?? (await promptForApiKey(dependencies.promptApiKey));
      const baseUrl = globals.baseUrl ?? existingConfig.baseUrl ?? DEFAULT_BASE_URL;
      const config = { apiKey, baseUrl };

      await saveConfig(config, configPath);
      writeOutput(stdout, globals.json ? config : formatConfigSaved(config));
    });

  program
    .command("chat")
    .description("send a prompt through RouteMind")
    .argument("<prompt>", "prompt to send")
    .option("--model <model>", "model to request", "auto")
    .option(
      "--strategy <strategy>",
      "routing strategy: balanced, cost_first, quality_first, latency_first",
      "balanced",
    )
    .option("--max-cost-tier <tier>", "max cost tier: low, medium, high")
    .option("--max-estimated-cost-usd <amount>", "maximum estimated request cost in USD")
    .option("--routing-mode <mode>", "routing mode: rule_based, score_based, llm_assisted")
    .option("--stream", "stream response tokens as they arrive")
    .action(async (prompt: string, options: ChatOptions) => {
      const globals = getGlobalOptions(program);
      const client = await buildClient(globals, configPath, createClient);
      const spinner = startSpinner(globals, spinnerFactory, "Routing prompt through RouteMind...");
      const request = {
        model: options.model ?? "auto",
        messages: [{ role: "user", content: prompt }],
        stream: options.stream,
        routing: {
          strategy: strategyMap[options.strategy ?? "balanced"],
          mode: options.routingMode,
          maxCostTier: options.maxCostTier,
          maxEstimatedCostUsd: parseOptionalNumber(options.maxEstimatedCostUsd),
        },
      } as const;

      if (options.stream) {
        const stream = client.chat.completions.create({
          ...request,
          stream: true,
        });

        spinner?.succeed("Streaming RouteMind response.");
        if (!globals.json) {
          stdout.write(`${chalk.bold("Answer:")}\n`);
        }
        await writeChatStream(stdout, stream, Boolean(globals.json));
        return;
      }

      const response = await client.chat.completions.create({
        ...request,
        stream: false,
      });

      spinner?.succeed("RouteMind response received.");
      writeOutput(stdout, globals.json ? response : formatChatResponse(response, options));
    });

  program
    .command("health")
    .description("show provider health")
    .action(async () => {
      const globals = getGlobalOptions(program);
      const client = await buildClient(globals, configPath, createClient);
      const response = await withSpinner(
        globals,
        spinnerFactory,
        "Loading provider health...",
        () => client.health.providers.list(),
      );

      writeOutput(stdout, globals.json ? response : formatHealth(response));
    });

  program
    .command("analytics")
    .description("show usage analytics summary for a workspace")
    .requiredOption("--workspace <workspaceId>", "workspace id to query")
    .action(async (options: { readonly workspace: string }) => {
      const globals = getGlobalOptions(program);
      const client = await buildClient(globals, configPath, createClient);
      const response = await withSpinner(globals, spinnerFactory, "Loading analytics...", () =>
        client.analytics.summary(options.workspace),
      );

      writeOutput(stdout, globals.json ? response : formatAnalytics(response));
    });

  program
    .command("models")
    .description("list models reported by provider health")
    .action(async () => {
      const globals = getGlobalOptions(program);
      const client = await buildClient(globals, configPath, createClient);
      const response = await withSpinner(globals, spinnerFactory, "Loading models...", () =>
        client.health.providers.list(),
      );

      writeOutput(stdout, globals.json ? response : formatModels(response));
    });

  program
    .command("costs")
    .description("show cost summary for a workspace")
    .requiredOption("--workspace <workspaceId>", "workspace id to query")
    .action(async (options: { readonly workspace: string }) => {
      const globals = getGlobalOptions(program);
      const client = await buildClient(globals, configPath, createClient);
      const response = await withSpinner(globals, spinnerFactory, "Loading costs...", () =>
        client.analytics.summary(options.workspace),
      );

      writeOutput(stdout, globals.json ? response : formatCosts(response));
    });

  program
    .command("circuit-breakers")
    .description("list circuit breaker state")
    .action(async () => {
      const globals = getGlobalOptions(program);
      const client = await buildClient(globals, configPath, createClient);
      const response = await withSpinner(
        globals,
        spinnerFactory,
        "Loading circuit breakers...",
        () => client.resilience.circuitBreakers.list(),
      );

      writeOutput(stdout, globals.json ? response : formatCircuitBreakers(response));
    });

  program
    .command("config")
    .description("show current local RouteMind CLI config")
    .action(async () => {
      const globals = getGlobalOptions(program);
      const config = await resolveConfig(globals, configPath);
      const displayConfig = { ...config, apiKey: maskApiKey(config.apiKey) };

      writeOutput(stdout, globals.json ? displayConfig : formatConfig(displayConfig, configPath));
    });

  program.hook("postAction", () => {
    stdout.write("");
  });

  program.configureOutput({
    writeErr: (message) => stderr.write(message),
  });

  return program;
}

async function buildClient(
  globals: GlobalOptions,
  configPath: string,
  createClient: (options: RouteMindClientOptions) => RouteMindClient,
): Promise<RouteMindClient> {
  const config = await resolveConfig(globals, configPath);

  if (!config.apiKey) {
    throw new RouteMindCliError("No RouteMind API key configured. Run `routemind login` first.");
  }

  return createClient({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
  });
}

async function resolveConfig(
  globals: GlobalOptions,
  configPath: string,
): Promise<RouteMindCliConfig> {
  const config = await loadConfig(configPath);

  return {
    apiKey: globals.apiKey ?? config.apiKey,
    baseUrl: globals.baseUrl ?? config.baseUrl ?? DEFAULT_BASE_URL,
  };
}

function getGlobalOptions(command: Command): GlobalOptions {
  return command.opts<GlobalOptions>();
}

async function promptForApiKey(promptApiKey?: () => Promise<string>): Promise<string> {
  if (promptApiKey) {
    return promptApiKey();
  }

  const readline = createInterface({ input: defaultStdin, output: defaultStdout });

  try {
    return (await readline.question("RouteMind API key: ")).trim();
  } finally {
    readline.close();
  }
}

async function withSpinner<T>(
  globals: GlobalOptions,
  spinnerFactory: SpinnerFactory,
  message: string,
  operation: () => Promise<T>,
): Promise<T> {
  const spinner = startSpinner(globals, spinnerFactory, message);

  try {
    const response = await operation();
    spinner?.succeed("Done.");
    return response;
  } catch (error) {
    spinner?.fail("Request failed.");
    throw error;
  }
}

function startSpinner(
  globals: GlobalOptions,
  spinnerFactory: SpinnerFactory,
  message: string,
): Spinner | undefined {
  if (globals.json) {
    return undefined;
  }

  return spinnerFactory(message).start();
}

function createOraSpinner(text: string): Spinner {
  return ora(text);
}

function writeOutput(stdout: OutputWriter, value: unknown): void {
  if (typeof value === "string") {
    stdout.write(`${value}\n`);
    return;
  }

  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function formatConfigSaved(config: RouteMindCliConfig): string {
  return [
    chalk.green("RouteMind CLI config saved."),
    `API key: ${maskApiKey(config.apiKey)}`,
    `Base URL: ${config.baseUrl}`,
  ].join("\n");
}

function formatConfig(config: RouteMindCliConfig, configPath: string): string {
  return [
    chalk.bold("RouteMind Config"),
    `Path: ${configPath}`,
    `API key: ${config.apiKey ?? "not set"}`,
    `Base URL: ${config.baseUrl}`,
  ].join("\n");
}

function formatChatResponse(response: ChatCompletionResponse, options: ChatOptions): string {
  const answer = response.choices[0]?.message.content ?? "";
  const metadata = response.metadata;
  const routing = response.routingMetadata;

  return [
    chalk.bold("Answer:"),
    answer,
    "",
    chalk.bold("Routing:"),
    `- Requested: ${metadata?.requestedModel ?? response.model}`,
    `- Selected: ${metadata?.selectedModel ?? routing?.selectedModel ?? response.model}`,
    `- Provider: ${metadata?.provider ?? routing?.selectedProvider ?? "unknown"}`,
    `- Cost: ${formatUsd(metadata?.actualCostUsd ?? metadata?.estimatedCost)}`,
    `- Latency: ${formatMs(metadata?.latencyMs)}`,
    `- Strategy: ${options.strategy ?? routing?.routingStrategy ?? "balanced"}`,
  ].join("\n");
}

async function writeChatStream(
  stdout: OutputWriter,
  stream: ChatCompletionStream,
  json: boolean,
): Promise<void> {
  for await (const chunk of stream) {
    if (json) {
      stdout.write(`${JSON.stringify(chunk)}\n`);
      continue;
    }

    if (isChatCompletionChunk(chunk)) {
      stdout.write(chunk.choices[0]?.delta.content ?? "");
    }
  }

  if (!json) {
    stdout.write("\n");
  }
}

function isChatCompletionChunk(chunk: unknown): chunk is ChatCompletionChunk {
  return (
    typeof chunk === "object" &&
    chunk !== null &&
    "object" in chunk &&
    (chunk as { readonly object?: unknown }).object === "chat.completion.chunk"
  );
}

function formatHealth(response: ProviderHealthResponse): string {
  const rows = response.providers.flatMap((provider) =>
    provider.models.map((model) => [
      provider.provider,
      model.model,
      model.status,
      formatMs(model.avgLatencyMs),
      formatPercent(model.successRate),
      String(model.sampleSize),
    ]),
  );

  return [
    chalk.bold("Provider Health"),
    formatTable(["Provider", "Model", "Status", "Avg", "Success", "N"], rows),
  ].join("\n");
}

function formatModels(response: ProviderHealthResponse): string {
  const rows = response.providers.flatMap((provider) =>
    provider.models.map((model) => [
      provider.provider,
      model.model,
      model.status,
      formatMs(model.p95LatencyMs),
      formatPercent(model.errorRate),
    ]),
  );

  return [
    chalk.bold("Models"),
    formatTable(["Provider", "Model", "Status", "P95", "Errors"], rows),
  ].join("\n");
}

function formatAnalytics(summary: AnalyticsSummary): string {
  return [
    chalk.bold("Usage Summary"),
    `Requests: ${summary.requests.total} total, ${summary.requests.success} success, ${summary.requests.failed} failed`,
    `Success rate: ${formatPercent(summary.requests.successRate)}`,
    `Spend: ${formatUsd(summary.cost.totalSpendUsd)}`,
    `Tokens: ${summary.tokens.total} total (${summary.tokens.input} input, ${summary.tokens.output} output)`,
    `Latency: ${formatMs(summary.latency.averageMs)} avg, ${formatMs(summary.latency.p95Ms)} p95`,
    `Fallbacks: ${summary.routing.fallbackUsed}`,
    `Guardrails: ${summary.guardrails.budgetBlocked} budget, ${summary.guardrails.quotaBlocked} quota`,
  ].join("\n");
}

function formatCosts(summary: AnalyticsSummary): string {
  return [
    chalk.bold("Cost Summary"),
    `Total spend: ${formatUsd(summary.cost.totalSpendUsd)}`,
    `Average cost/request: ${formatUsd(summary.cost.averageCostPerRequest)}`,
    `Requests: ${summary.requests.total}`,
    `Budget blocked: ${summary.guardrails.budgetBlocked}`,
    `Quota blocked: ${summary.guardrails.quotaBlocked}`,
  ].join("\n");
}

function formatCircuitBreakers(response: CircuitBreakerListResponse): string {
  const rows = response.circuitBreakers.map((breaker) => [
    breaker.provider,
    breaker.model,
    breaker.state,
    String(breaker.failureCount),
    breaker.lastFailureAt ?? "-",
  ]);

  return [
    chalk.bold("Circuit Breakers"),
    formatTable(["Provider", "Model", "State", "Failures", "Last failure"], rows),
  ].join("\n");
}

function formatTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) {
    return "No data.";
  }

  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const formatRow = (row: readonly string[]) =>
    row.map((cell, index) => cell.padEnd(widths[index] ?? cell.length)).join("  ");
  const divider = widths.map((width) => "-".repeat(width)).join("  ");

  return [formatRow(headers), divider, ...rows.map(formatRow)].join("\n");
}

function formatUsd(value?: number): string {
  if (value === undefined) {
    return "unknown";
  }

  return `$${value.toFixed(4)}`;
}

function formatMs(value?: number): string {
  if (value === undefined) {
    return "unknown";
  }

  return `${Math.round(value)}ms`;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function parseOptionalNumber(value?: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new RouteMindCliError(`Invalid numeric value: ${value}`);
  }

  return parsed;
}

class RouteMindCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouteMindCliError";
  }
}

async function main(): Promise<void> {
  const program = createProgram();

  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  }
}

function formatCliError(error: unknown): string {
  if (error instanceof RouteMindError) {
    return `${chalk.red("RouteMind error:")} ${error.message}`;
  }
  if (error instanceof Error) {
    return `${chalk.red("Error:")} ${error.message}`;
  }

  return chalk.red("Unknown RouteMind CLI error.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void main();
}
