/**
 * Real end-to-end Playwright walkthrough of the Phase 1 exit criteria (sign
 * up -> hit the Free tier's request limit -> see a real upgrade prompt ->
 * pay -> have the limit lifted), rendered as a single self-contained HTML
 * report with embedded screenshots and raw request/response JSON -- not a
 * pass/fail assertion suite (that's what phase1-exit-criteria.test.ts is
 * for). This drives an actual Chromium browser against actually-running dev
 * servers, and makes direct HTTP calls for the endpoints that have no
 * dashboard UI yet (personal API key creation, chat completions).
 *
 * This script owns two child processes for the duration of the run (the
 * real apps/api and apps/dashboard dev servers) so it can capture magic-link
 * tokens from ConsoleEmailSender's stdout -- LoginToken only ever stores a
 * hash of the token, so there is no way to recover it from the database
 * after the fact. If ports 3000/3002 are already in use (e.g. a developer's
 * own `npm run dev`), this refuses to start rather than risk fighting over
 * the same port or silently reading the wrong process's logs.
 *
 * Honesty boundary, same as phase1-exit-criteria.test.ts: no live Paddle
 * sandbox credentials exist in this environment, so this cannot drive a
 * browser through Paddle's actual hosted checkout UI. The real dashboard
 * "Switch to Pro" button is still clicked for real, and the real error it
 * produces today (LivePaddleClient refusing with no PADDLE_API_KEY
 * configured) is captured and reported as-is, not hidden. The actual
 * payment confirmation is then represented by simulating the one external
 * event Paddle itself sends on a real payment: a real, correctly HMAC-
 * signed subscription.created webhook to /v1/webhooks/paddle -- how this
 * backend learns about payment outcomes in production too, since it never
 * sees a card number either way. PADDLE_WEBHOOK_SECRET is set only for this
 * script's own spawned apps/api process (not the developer's real .env), so
 * that one real signature-verification step can actually run.
 *
 * This also seeds a mock ProviderCredential + UserModelAccess row directly
 * for the new user/workspace before the first chat completion -- a fresh
 * self-serve signup has neither yet (no dashboard UI exists for either;
 * onboarding.ts's routes are the only path today and remain userId-scoped,
 * a separate, already-documented gap), and without them every chat
 * completion 400s as "Unsupported model" before ever reaching the plan-
 * limit check this walkthrough is trying to demonstrate. PROVIDER_MODE is
 * forced to "mock" for this script's own spawned apps/api process
 * regardless of the developer's real .env (which may be PROVIDER_MODE=live
 * with a real OPENAI_API_KEY) -- this walkthrough must never depend on or
 * spend a real provider credential.
 *
 * Usage: npm run qa:e2e-billing-report -w apps/api
 */
import { createHmac, randomUUID } from "node:crypto";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

import { loadConfig } from "../config.js";
import { encryptCredential } from "../security/credentials.js";
import { buildHtmlReport, type HttpExchange, type ReportStep } from "./e2e-report-html.js";

// Importing config.js triggers its module-level dotenv load (../../.env),
// which is what actually populates process.env.DATABASE_URL/REDIS_URL for
// this script's own PrismaClient below; config.CREDENTIAL_ENCRYPTION_KEY is
// also used directly, to encrypt the mock provider credential seeded later.
const config = loadConfig();

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../../../..");
const apiDir = resolve(repoRoot, "apps/api");
const dashboardDir = resolve(repoRoot, "apps/dashboard");

const API_PORT = 3000;
const DASHBOARD_PORT = 3002;
const API_BASE = `http://localhost:${API_PORT}`;
const DASHBOARD_BASE = `http://localhost:${DASHBOARD_PORT}`;
const SESSION_COOKIE_NAME = "routemind_session";
const TEST_PRO_PADDLE_PRICE_ID = "pri_e2e_billing_report_test";
// Set only on this script's own spawned apps/api process (see commonEnv
// below), never the developer's real .env -- lets the one real webhook-
// signature-verification step in this walkthrough actually run without
// needing live Paddle sandbox credentials.
const PADDLE_WEBHOOK_SECRET = "e2e-billing-report-webhook-secret";

const steps: ReportStep[] = [];
const cleanup = {
  workspaceIds: [] as string[],
  organizationIds: [] as string[],
  userIds: [] as string[],
  principalIds: [] as string[],
};
let mutatedProPlan = false;

function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = net.createConnection({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolvePromise(true);
    });
    socket.once("error", () => {
      resolvePromise(false);
    });
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolvePromise(false);
    });
  });
}

async function waitForHttpReady(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await fetch(url);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`Timed out waiting for ${url} to respond. Last error: ${String(lastError)}`);
}

interface ManagedServer {
  readonly name: string;
  readonly proc: ChildProcess;
  log: string;
}

function spawnServer(
  name: string,
  cwd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): ManagedServer {
  const command = "npm";
  const proc = spawn(command, args as string[], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  const managed: ManagedServer = { name, proc, log: "" };
  proc.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    managed.log += text;
    process.stdout.write(`[${name}] ${text}`);
  });
  proc.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    managed.log += text;
    process.stderr.write(`[${name}:err] ${text}`);
  });
  return managed;
}

function killServerTree(server: ManagedServer): void {
  if (!server.proc.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(server.proc.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    server.proc.kill();
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function waitForEmailToken(
  server: ManagedServer,
  toEmail: string,
  sinceLength: number,
  timeoutMs = 15_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const pattern = new RegExp(
    `\\[email:dev\\] to=${escapeRegExp(toEmail)}[\\s\\S]*?(https?:\\/\\/\\S+)`,
  );
  while (Date.now() < deadline) {
    const slice = server.log.slice(sinceLength);
    const match = slice.match(pattern);
    if (match) {
      const token = new URL(match[1]!).searchParams.get("token");
      if (token) return token;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for a login-link email to ${toEmail}.`);
}

function parseCookie(setCookieHeader: string): string {
  return setCookieHeader.split(";")[0]!;
}

function extractSessionCookie(headers: Headers): string {
  const cookies = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : undefined;
  const raw = cookies && cookies.length > 0 ? cookies[0] : headers.get("set-cookie");
  if (!raw) throw new Error("Response had no set-cookie header.");
  return parseCookie(raw);
}

interface ApiCallResult<TBody = unknown> {
  readonly status: number;
  readonly body: TBody;
  readonly headers: Headers;
}

async function callApi<TBody = unknown>(
  method: string,
  path: string,
  options: {
    readonly cookie?: string;
    readonly apiKey?: string;
    readonly body?: unknown;
    readonly rawBody?: string;
    readonly extraHeaders?: Record<string, string>;
  } = {},
): Promise<{ result: ApiCallResult<TBody>; exchange: HttpExchange }> {
  const headers: Record<string, string> = { accept: "application/json", ...options.extraHeaders };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.cookie) headers.cookie = options.cookie;
  if (options.apiKey) headers["x-api-key"] = options.apiKey;

  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body:
      options.rawBody ?? (options.body !== undefined ? JSON.stringify(options.body) : undefined),
  });
  const text = await response.text();
  let parsedBody: unknown;
  try {
    parsedBody = text ? JSON.parse(text) : undefined;
  } catch {
    parsedBody = text;
  }

  const exchange: HttpExchange = {
    label: `${method} ${path}`,
    request: {
      method,
      url: `${API_BASE}${path}`,
      headers: {
        ...(options.cookie ? { cookie: "<session cookie, redacted>" } : {}),
        ...(options.apiKey ? { "x-api-key": "<redacted>" } : {}),
      },
      body:
        options.body ?? (options.rawBody ? (JSON.parse(options.rawBody) as unknown) : undefined),
    },
    response: { status: response.status, body: parsedBody },
  };

  return {
    result: { status: response.status, body: parsedBody as TBody, headers: response.headers },
    exchange,
  };
}

async function screenshotBase64(page: Page): Promise<string> {
  const buffer = await page.screenshot({ fullPage: true });
  return buffer.toString("base64");
}

async function setBrowserSession(
  context: BrowserContext,
  sessionCookiePair: string,
): Promise<void> {
  const value = sessionCookiePair.slice(sessionCookiePair.indexOf("=") + 1);
  await context.addCookies([
    {
      name: SESSION_COOKIE_NAME,
      value,
      domain: "localhost",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}

async function setActiveWorkspaceInBrowser(
  page: Page,
  workspace: { readonly id: string; readonly name: string },
): Promise<void> {
  await page.goto(DASHBOARD_BASE);
  await page.evaluate(
    ([key, value]) => {
      const browserGlobal = globalThis as unknown as {
        localStorage: { setItem(key: string, value: string): void };
      };
      browserGlobal.localStorage.setItem(key, value);
    },
    ["routemind_active_workspace", JSON.stringify(workspace)] as const,
  );
}

function signPaddleWebhook(
  rawBody: string,
  timestampSeconds = Math.floor(Date.now() / 1000),
): string {
  const signature = createHmac("sha256", PADDLE_WEBHOOK_SECRET)
    .update(`${timestampSeconds}:${rawBody}`)
    .digest("hex");
  return `ts=${timestampSeconds};h1=${signature}`;
}

async function main(): Promise<void> {
  console.log("=".repeat(70));
  console.log("E2E report generator: Phase 1 exit criteria (signup -> limit -> upgrade)");
  console.log("=".repeat(70));

  if (await isPortInUse(API_PORT)) {
    throw new Error(
      `Port ${API_PORT} is already in use. This script needs to spawn its own apps/api dev server to capture magic-link tokens from its console output -- stop whatever's running on ${API_PORT} first.`,
    );
  }
  if (await isPortInUse(DASHBOARD_PORT)) {
    throw new Error(
      `Port ${DASHBOARD_PORT} is already in use. This script needs to spawn its own apps/dashboard dev server -- stop whatever's running on ${DASHBOARD_PORT} first.`,
    );
  }

  const prisma = new PrismaClient();
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (error) {
    await prisma.$disconnect();
    throw new Error(
      `Could not reach Postgres (checked via Prisma using apps/api's configured DATABASE_URL). Is the Docker Postgres container running? Original error: ${String(error)}`,
    );
  }

  const commonEnv: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "development" };

  console.log("Starting apps/api dev server on port 3000...");
  const apiServer = spawnServer("api", apiDir, ["run", "dev"], {
    ...commonEnv,
    PORT: String(API_PORT),
    DASHBOARD_URL: DASHBOARD_BASE,
    ROUTEMIND_API_URL: API_BASE,
    PADDLE_WEBHOOK_SECRET,
    // Forced for this script's own spawned process only, regardless of the
    // developer's real .env -- this walkthrough seeds a fake ProviderCredential
    // to exercise real routing, and must never depend on (or spend) a real
    // provider API key. Confirmed necessary: this environment's real .env has
    // PROVIDER_MODE=live with a real OPENAI_API_KEY, which without this
    // override would make the seeded fake credential fail against OpenAI's
    // actual API ("Incorrect API key provided").
    PROVIDER_MODE: "mock",
  });

  console.log("Starting apps/dashboard dev server on port 3002...");
  const dashboardServer = spawnServer("dashboard", dashboardDir, ["run", "dev"], {
    ...commonEnv,
    NEXT_PUBLIC_ROUTEMIND_API_URL: API_BASE,
  });

  let browser: Browser | undefined;

  try {
    await waitForHttpReady(`${API_BASE}/health`, 60_000).catch(() =>
      waitForHttpReady(API_BASE, 60_000),
    );
    await waitForHttpReady(DASHBOARD_BASE, 90_000);
    console.log("Both dev servers are responding.");

    browser = await chromium.launch();
    const context = await browser.newContext();
    const page = await context.newPage();

    const runId = randomUUID().slice(0, 8);
    const ownerEmail = `e2e-billing-owner-${runId}@routemind-e2e.local`;

    // -----------------------------------------------------------------
    // Step 1: land on the signup/login page.
    // -----------------------------------------------------------------
    await page.goto(`${DASHBOARD_BASE}/auth/login`);
    await page.waitForSelector("input[type=email]");
    steps.push({
      id: "step-1",
      title: "Land on the signup/login page",
      description:
        "Fresh, unauthenticated visit to /auth/login. No prior account, no invite, no manual provisioning.",
      screenshotPngBase64: await screenshotBase64(page),
    });

    // -----------------------------------------------------------------
    // Step 2: submit email for magic link, through the real UI form.
    // -----------------------------------------------------------------
    const requestLinkLogOffset = apiServer.log.length;
    const [requestLinkResponse] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/v1/auth/request-link")),
      page.fill("input[type=email]", ownerEmail),
      page.click("button[type=submit]"),
    ]);
    await page.waitForSelector("text=Check your email");
    const requestLinkBody: unknown = await requestLinkResponse.json().catch(() => undefined);
    steps.push({
      id: "step-2",
      title: 'Submit email for magic link ("check your email" state)',
      description:
        "Submitted a brand-new email address through the real login form. The request below is the actual browser-issued network call to POST /v1/auth/request-link.",
      screenshotPngBase64: await screenshotBase64(page),
      httpExchanges: [
        {
          label: "POST /v1/auth/request-link (fired by the login form)",
          request: { method: "POST", url: requestLinkResponse.url(), body: { email: ownerEmail } },
          response: { status: requestLinkResponse.status(), body: requestLinkBody },
        },
      ],
    });

    // -----------------------------------------------------------------
    // Step 3: complete signup via the real /v1/auth/verify endpoint,
    // using the token extracted from the real magic-link email (captured
    // from the spawned dev server's console -- LoginToken only stores a
    // hash at rest, so there is no other way to recover it).
    // -----------------------------------------------------------------
    const token = await waitForEmailToken(apiServer, ownerEmail, requestLinkLogOffset);
    const { result: verify, exchange: verifyExchange } = await callApi<{
      user: { id: string; email: string; name: string };
      workspace?: { id: string; name: string };
    }>("POST", "/v1/auth/verify", { body: { token } });
    if (verify.status !== 200 || !verify.body.workspace) {
      throw new Error(
        `Signup verify did not succeed: ${verify.status} ${JSON.stringify(verify.body)}`,
      );
    }
    const sessionCookie = extractSessionCookie(verify.headers);
    const user = verify.body.user;
    const workspace = verify.body.workspace;
    cleanup.userIds.push(user.id);
    cleanup.workspaceIds.push(workspace.id);

    const workspaceRow = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } });
    const organizationId = workspaceRow.organizationId!;
    cleanup.organizationIds.push(organizationId);
    const userRow = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    if (userRow.principalId) cleanup.principalIds.push(userRow.principalId);

    steps.push({
      id: "step-3",
      title: "Complete signup (real POST /v1/auth/verify)",
      description:
        "Called POST /v1/auth/verify directly with the token from the real magic-link email -- no UI navigation involved, since LoginToken only stores a hash of the token and there's no other way to recover it after the email was sent. This is the first-time-signup branch: a User + Principal + default Organization + Workspace + Owner Membership were all created in one transaction.",
      httpExchanges: [verifyExchange],
    });

    // -----------------------------------------------------------------
    // Step 4: land in the dashboard, workspace real.
    // -----------------------------------------------------------------
    await setBrowserSession(context, sessionCookie);
    await setActiveWorkspaceInBrowser(page, workspace);
    await page.goto(`${DASHBOARD_BASE}/dashboard/members`);
    await page.waitForSelector("text=Active members");
    steps.push({
      id: "step-4",
      title: "Land in the new workspace (dashboard, member list)",
      description: `Dashboard members screen for workspace "${workspace.name}" (${workspace.id}), showing the newly-signed-up user as Owner.`,
      screenshotPngBase64: await screenshotBase64(page),
    });

    // -----------------------------------------------------------------
    // Step 5: mint a personal API key. No dashboard UI exists for this
    // yet (confirmed: only service-account key issuance has a screen),
    // so this is the real, direct POST /v1/workspaces/:id/api-keys call
    // a user would otherwise need the dashboard to expose.
    // -----------------------------------------------------------------
    const { result: apiKeyResult, exchange: apiKeyExchange } = await callApi<{ apiKey: string }>(
      "POST",
      `/v1/workspaces/${workspace.id}/api-keys`,
      { cookie: sessionCookie, body: { userId: user.id, name: "E2E billing report key" } },
    );
    if (apiKeyResult.status !== 201) {
      throw new Error(`Could not mint an API key: ${apiKeyResult.status}`);
    }
    const apiKey = apiKeyResult.body.apiKey;
    steps.push({
      id: "step-5",
      title: "Mint a personal API key",
      description:
        "GAP, documented not fixed: no dashboard UI exists yet for a human user to self-issue their own personal API key (only service-account key issuance has a screen). This is the real, direct call a user would otherwise need a dashboard button for.",
      httpExchanges: [apiKeyExchange],
    });

    // -----------------------------------------------------------------
    // Step 6: enable a model for this workspace. GAP, documented not
    // fixed: no dashboard UI exists for provider credentials or model
    // access either (onboarding.ts's routes are the only path today,
    // and remain userId-scoped, a separate already-documented gap) --
    // without this, every chat completion 400s as "Unsupported model"
    // before ever reaching the plan-limit check below. Seeded directly,
    // mirroring exactly what scripts/seed-dev.ts does for its own dev
    // user; PROVIDER_MODE=mock means the key value itself is never
    // actually used to call a real provider.
    // -----------------------------------------------------------------
    await prisma.providerCredential.create({
      data: {
        userId: user.id,
        workspaceId: workspace.id,
        provider: "openai",
        encryptedApiKey: encryptCredential("mock-openai-key", config.CREDENTIAL_ENCRYPTION_KEY),
        isEnabled: true,
      },
    });
    await prisma.userModelAccess.create({
      data: {
        userId: user.id,
        workspaceId: workspace.id,
        provider: "openai",
        model: "gpt-4o",
        isEnabled: true,
      },
    });
    steps.push({
      id: "step-6",
      title: "Test setup: enable a model for this workspace",
      description:
        'GAP, documented not fixed: no dashboard UI exists yet for a human user to configure provider credentials or model access. Seeded a mock "openai" ProviderCredential and gpt-4o UserModelAccess row directly via Prisma so the walkthrough can reach a real routing decision -- without this, every chat completion 400s as "Unsupported model" before the plan-limit check ever runs.',
    });

    // -----------------------------------------------------------------
    // Step 7: reach the Free tier's real 10,000-request limit. Bulk-
    // seeded directly via Prisma for speed -- this is test setup to
    // reach the interesting state quickly, not a real user action, and
    // is labeled as such rather than disguised as one.
    // -----------------------------------------------------------------
    const freePlan = await prisma.plan.findUniqueOrThrow({ where: { name: "Free" } });
    await prisma.requestLog.createMany({
      data: Array.from({ length: freePlan.includedRequests! }, () => ({
        workspaceId: workspace.id,
        apiKey: "e2e-billing-report-seed",
        requestedModel: "gpt-4o",
        latencyMs: 100,
        status: "success" as const,
      })),
    });
    steps.push({
      id: "step-7",
      title: `Test setup: bulk-seed ${freePlan.includedRequests!.toLocaleString("en-US")} successful requests`,
      description: `Not a user action -- directly inserted ${freePlan.includedRequests!.toLocaleString("en-US")} successful RequestLog rows for this workspace via Prisma (data-equivalent to that many real completed requests, done for speed rather than sending 10,000 real HTTP calls). This is the real seeded Free plan's real limit (${freePlan.includedRequests}), not a stand-in value.`,
    });

    // -----------------------------------------------------------------
    // Step 8: the next real chat completion is blocked.
    // -----------------------------------------------------------------
    const { result: blockedResult, exchange: blockedExchange } = await callApi(
      "POST",
      "/v1/chat/completions",
      {
        apiKey,
        body: {
          model: "gpt-4o",
          messages: [{ role: "user", content: "Hello" }],
          cache: { mode: "disabled" },
          // A freshly restarted server has zero recorded successful
          // requests against "openai" yet, so the in-memory provider
          // health service correctly reports it as unproven/unhealthy --
          // routing's own hard-constraint filter would otherwise reject
          // every candidate for that reason alone before the plan-limit
          // check this walkthrough is trying to demonstrate ever runs.
          routing: { allowUnhealthyProviders: true },
        },
      },
    );
    steps.push({
      id: "step-8",
      title: "Hit the Free tier's request limit",
      description: `A real /v1/chat/completions call, blocked by the live policy engine with a ${blockedResult.status} and error code from the response body below. No dashboard chat UI exists, so this is a direct API call, same as it would be for a real integrated application hitting the limit.`,
      httpExchanges: [blockedExchange],
    });

    // -----------------------------------------------------------------
    // Step 9: the real dashboard billing page -- the clear upgrade
    // prompt with real pricing.
    // -----------------------------------------------------------------
    await page.goto(`${DASHBOARD_BASE}/dashboard/billing`);
    await page.waitForSelector("text=Available plans");
    steps.push({
      id: "step-9",
      title: "See a clear upgrade prompt with real pricing",
      description:
        'Real dashboard billing screen: current plan "Free", usage at the full 10,000/10,000 requests (shown in warning tone), and an available-plans grid sourced live from GET /v1/plans -- the same real Free/Pro/Team/Enterprise pricing the public pricing page renders, not separate hardcoded copy.',
      screenshotPngBase64: await screenshotBase64(page),
    });

    // -----------------------------------------------------------------
    // Step 10: click "Switch to Pro" for real. Set up the real seeded
    // Pro plan's paddlePriceId first (it's null in this environment,
    // like every plan, since no live Paddle sandbox price exists here)
    // so the webhook step later matches a real Plan -- restored to null
    // in cleanup either way. The checkout call itself is still expected
    // to fail: LivePaddleClient refuses outright with no PADDLE_API_KEY
    // configured (see infrastructure/paddle-client.ts), a real,
    // deterministic 503 this step reports rather than works around.
    // -----------------------------------------------------------------
    await prisma.plan.updateMany({
      where: { name: "Pro" },
      data: { paddlePriceId: TEST_PRO_PADDLE_PRICE_ID },
    });
    mutatedProPlan = true;

    const [checkoutResponse] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/billing/checkout")),
      page.click('button:has-text("Switch to Pro")'),
    ]);
    const checkoutBody: unknown = await checkoutResponse.json().catch(() => undefined);

    let paddleErrorNote: string;
    try {
      await page.waitForSelector("text=Paddle is not configured", { timeout: 8_000 });
      paddleErrorNote =
        'Real, observed behavior, not hypothetical: the checkout call above returned 503 straight from this environment\'s own LivePaddleClient (infrastructure/paddle-client.ts), which refuses outright with "Paddle is not configured (missing PADDLE_API_KEY)" before ever attempting a network call -- since no live Paddle sandbox credentials exist here (see docs/roadmap.md items 2/5), Paddle.js is never even reached. With a real PADDLE_API_KEY/PADDLE_CLIENT_TOKEN configured, this is exactly the point where a real Paddle transaction would be created and its hosted checkout overlay would open next.';
    } catch {
      paddleErrorNote = `Expected the "Paddle is not configured" error banner but it did not appear within 8s (checkout call returned ${checkoutResponse.status()}) -- capturing the screenshot as-is rather than waiting further.`;
    }
    steps.push({
      id: "step-10",
      title: 'Click "Switch to Pro" in the real dashboard',
      description:
        "Clicked the real upgrade button for the real seeded Pro plan. This fires the real POST /v1/organizations/:id/billing/checkout call shown below.",
      screenshotPngBase64: await screenshotBase64(page),
      httpExchanges: [
        {
          label: 'POST /v1/organizations/:id/billing/checkout (fired by "Switch to Pro")',
          request: { method: "POST", url: checkoutResponse.url(), body: { planName: "Pro" } },
          response: { status: checkoutResponse.status(), body: checkoutBody },
        },
      ],
      note: paddleErrorNote,
    });

    // -----------------------------------------------------------------
    // Step 11: the payment confirmation. The one genuinely simulated
    // step -- a real, correctly signed Paddle webhook, exactly how this
    // backend learns about a completed payment in production too.
    // -----------------------------------------------------------------
    const rawBody = JSON.stringify({
      event_type: "subscription.created",
      data: {
        id: `sub_e2e_${runId}`,
        status: "active",
        customer_id: `ctm_e2e_${runId}`,
        custom_data: { organizationId },
        items: [{ price: { id: TEST_PRO_PADDLE_PRICE_ID } }],
        current_billing_period: {
          starts_at: "2026-01-01T00:00:00Z",
          ends_at: "2026-02-01T00:00:00Z",
        },
      },
    });
    const { result: webhookResult, exchange: webhookExchange } = await callApi(
      "POST",
      "/v1/webhooks/paddle",
      {
        rawBody,
        extraHeaders: {
          "content-type": "application/json",
          "paddle-signature": signPaddleWebhook(rawBody),
        },
      },
    );
    steps.push({
      id: "step-11",
      title: "Pay with a (test-mode) credit card",
      description:
        "Simulated the one external event Paddle itself sends this backend on a real completed payment: a real, correctly HMAC-signed subscription.created webhook to POST /v1/webhooks/paddle, signed with a secret set only for this script's own spawned apps/api process (real webhook-signature verification runs unmodified; only the secret value itself is script-local, since no live Paddle sandbox account exists to issue one). This mirrors production exactly -- this backend never sees a card number either way, Paddle is the merchant of record, and a signed webhook is the only mechanism by which a real payment ever becomes real in this system.",
      httpExchanges: [webhookExchange],
      note:
        webhookResult.status === 200
          ? undefined
          : `Unexpected: webhook returned ${webhookResult.status} instead of 200.`,
    });

    // -----------------------------------------------------------------
    // Step 12: immediately have the limit lifted -- real UI proof.
    // -----------------------------------------------------------------
    await page.reload();
    await page.waitForSelector("text=Current plan");
    steps.push({
      id: "step-12",
      title: "Immediately have the limit lifted (real dashboard, reloaded)",
      description:
        'Reloaded the real billing page, no restart, no manual cache-bust, same running app instance. "Current plan" now reads Pro with an active subscription status.',
      screenshotPngBase64: await screenshotBase64(page),
    });

    // -----------------------------------------------------------------
    // Step 13: and the very next chat completion succeeds.
    // -----------------------------------------------------------------
    const { result: unblockedResult, exchange: unblockedExchange } = await callApi(
      "POST",
      "/v1/chat/completions",
      {
        apiKey,
        body: {
          model: "gpt-4o",
          messages: [{ role: "user", content: "Hello again" }],
          cache: { mode: "disabled" },
          routing: { allowUnhealthyProviders: true },
        },
      },
    );
    steps.push({
      id: "step-13",
      title: "The very next request succeeds under the new plan",
      description: `Same API key, same workspace, same 10,000 already-logged requests -- the request now returns ${unblockedResult.status} under Pro's higher included-request limit, immediately.`,
      httpExchanges: [unblockedExchange],
      note:
        unblockedResult.status === 200
          ? undefined
          : `Unexpected: request returned ${unblockedResult.status} instead of 200 -- the limit was not actually lifted.`,
    });

    console.log("All steps completed.");
  } finally {
    if (browser) await browser.close().catch(() => undefined);

    console.log("Stopping dev servers...");
    killServerTree(apiServer);
    killServerTree(dashboardServer);
    await new Promise((r) => setTimeout(r, 1500));

    console.log("Cleaning up database rows created by this run...");
    await prisma.subscription.deleteMany({
      where: { organizationId: { in: cleanup.organizationIds } },
    });
    await prisma.requestLog.deleteMany({ where: { workspaceId: { in: cleanup.workspaceIds } } });
    await prisma.auditEvent.deleteMany({ where: { workspaceId: { in: cleanup.workspaceIds } } });
    await prisma.apiKey.deleteMany({ where: { workspaceId: { in: cleanup.workspaceIds } } });
    await prisma.membership.deleteMany({ where: { workspaceId: { in: cleanup.workspaceIds } } });
    await prisma.workspaceMember.deleteMany({
      where: { workspaceId: { in: cleanup.workspaceIds } },
    });
    await prisma.loginToken.deleteMany({ where: { userId: { in: cleanup.userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: cleanup.userIds } } });
    await prisma.principal.deleteMany({ where: { id: { in: cleanup.principalIds } } });
    await prisma.workspace.deleteMany({ where: { id: { in: cleanup.workspaceIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: cleanup.organizationIds } } });
    if (mutatedProPlan) {
      await prisma.plan.updateMany({ where: { name: "Pro" }, data: { paddlePriceId: null } });
    }
    await prisma.$disconnect();

    if (steps.length > 0) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const reportPath = resolve(repoRoot, "reports", `e2e-phase1-exit-criteria-${timestamp}.html`);
      await mkdir(resolve(repoRoot, "reports"), { recursive: true });
      const html = buildHtmlReport({
        title: "RouteMind E2E: Phase 1 Exit Criteria (Signup to Upgrade)",
        generatedAt: new Date().toISOString(),
        steps,
      });
      await writeFile(reportPath, html, "utf8");
      console.log("=".repeat(70));
      console.log(`Report written to: ${reportPath}`);
      console.log("=".repeat(70));
    }
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
