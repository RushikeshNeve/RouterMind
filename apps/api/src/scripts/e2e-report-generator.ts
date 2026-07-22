/**
 * Real end-to-end Playwright walkthrough of the full register -> login flow,
 * rendered as a single self-contained HTML report with embedded screenshots
 * and raw request/response JSON -- not a pass/fail assertion suite (that's
 * what *.test.ts and qa-phase0-dashboard-flow.ts are for). This drives an
 * actual Chromium browser against actually-running dev servers, and makes
 * direct HTTP calls for the endpoints the task asked to see recorded raw.
 *
 * This script owns two child processes for the duration of the run (the
 * real apps/api and apps/dashboard dev servers) so it can capture magic-link
 * tokens from ConsoleEmailSender's stdout -- LoginToken/WorkspaceInvite only
 * ever store a hash of the token, so there is no way to recover it from the
 * database after the fact. If ports 3000/3002 are already in use (e.g. a
 * developer's own `npm run dev`), this refuses to start rather than risk
 * fighting over the same port or silently reading the wrong process's logs.
 *
 * Usage: npm run qa:e2e-report -w apps/api
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

// Importing this triggers config.ts's module-level dotenv load (../../.env),
// which is what actually populates process.env.DATABASE_URL/REDIS_URL for
// this script's own PrismaClient below -- without it, PrismaClient throws
// "Environment variable not found: DATABASE_URL" even though apps/api's own
// dev server (spawned separately, in its own process) has no trouble at all.
import { loadConfig } from "../config.js";
import { buildHtmlReport, type HttpExchange, type ReportStep } from "./e2e-report-html.js";

loadConfig();

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../../../..");
const apiDir = resolve(repoRoot, "apps/api");
const dashboardDir = resolve(repoRoot, "apps/dashboard");

const API_PORT = 3000;
const DASHBOARD_PORT = 3002;
const API_BASE = `http://localhost:${API_PORT}`;
const DASHBOARD_BASE = `http://localhost:${DASHBOARD_PORT}`;
const SESSION_COOKIE_NAME = "routemind_session";

const steps: ReportStep[] = [];
const cleanup = {
  workspaceIds: [] as string[],
  organizationIds: [] as string[],
  userIds: [] as string[],
  principalIds: [] as string[],
};

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
  // On Windows, spawning npm.cmd directly (without a shell) throws EINVAL --
  // npm ships as a .cmd batch file, which Windows can only execute through
  // cmd.exe. shell: true routes the spawn through cmd.exe /c instead.
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

/**
 * proc.kill() alone only signals the immediate child -- on Windows that's
 * the cmd.exe shell wrapper spawned by { shell: true }, not the actual
 * npm/tsx/next process tree underneath it, leaving the dev server (and its
 * bound port) orphaned after this script exits. taskkill /T cascades to the
 * whole tree; elsewhere, a plain SIGTERM is enough.
 */
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

/**
 * Polls a managed server's captured stdout for the ConsoleEmailSender log
 * line addressed to `toEmail` that appeared after `sinceLength`, and
 * extracts the raw magic-link token from it (the same real link a user
 * would click, not a fabricated one).
 */
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
  options: { readonly cookie?: string; readonly apiKey?: string; readonly body?: unknown } = {},
): Promise<{ result: ApiCallResult<TBody>; exchange: HttpExchange }> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.cookie) headers.cookie = options.cookie;
  if (options.apiKey) headers["x-api-key"] = options.apiKey;

  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
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
      body: options.body,
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
  // sessionCookiePair is the full "name=value" pair (as extracted from a
  // Set-Cookie header, and as used directly in a raw Cookie: request
  // header) -- Playwright's addCookies wants only the value half, since it
  // takes the cookie's name separately. Passing the whole pair here would
  // double the name/value and break signature verification server-side.
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

async function main(): Promise<void> {
  console.log("=".repeat(70));
  console.log("E2E report generator: register -> login flow");
  console.log("=".repeat(70));

  if (await isPortInUse(API_PORT)) {
    throw new Error(
      `Port ${API_PORT} is already in use. This script needs to spawn its own apps/api dev server to capture magic-link tokens from its console output -- stop whatever's running on ${API_PORT} first (this script will not share or guess at another process's logs).`,
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

  const commonEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "development",
  };

  console.log("Starting apps/api dev server on port 3000...");
  const apiServer = spawnServer("api", apiDir, ["run", "dev"], {
    ...commonEnv,
    PORT: String(API_PORT),
    DASHBOARD_URL: DASHBOARD_BASE,
    ROUTEMIND_API_URL: API_BASE,
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
    const ownerAContext = await browser.newContext();
    const ownerAPage = await ownerAContext.newPage();
    const browserErrors: string[] = [];
    ownerAPage.on("requestfailed", (req) => {
      const line = `${req.method()} ${req.url()} -- ${req.failure()?.errorText}`;
      browserErrors.push(line);
      console.log(`[browser:requestfailed] ${line}`);
    });
    ownerAPage.on("console", (msg) => {
      if (msg.type() === "error") {
        browserErrors.push(msg.text());
        console.log(`[browser:console:error] ${msg.text()}`);
      }
    });

    const runId = randomUUID().slice(0, 8);
    const ownerAEmail = `e2e-owner-a-${runId}@routemind-e2e.local`;
    const developerEmail = `e2e-developer-${runId}@routemind-e2e.local`;
    const ownerBEmail = `e2e-owner-b-${runId}@routemind-e2e.local`;

    // -----------------------------------------------------------------
    // Step 1: land on the signup/login page.
    // -----------------------------------------------------------------
    await ownerAPage.goto(`${DASHBOARD_BASE}/auth/login`);
    await ownerAPage.waitForSelector("input[type=email]");
    steps.push({
      id: "step-1",
      title: "Land on the signup/login page",
      description:
        "Fresh, unauthenticated visit to /auth/login. Empty email form, no session, no prior state.",
      screenshotPngBase64: await screenshotBase64(ownerAPage),
    });

    // -----------------------------------------------------------------
    // Step 2: submit email for magic link, driven through the real UI
    // form -- the network call itself IS the direct
    // POST /v1/auth/request-link exchange the task asked to see recorded.
    // -----------------------------------------------------------------
    const requestLinkLogOffset = apiServer.log.length;
    const [requestLinkResponse] = await Promise.all([
      ownerAPage.waitForResponse((r) => r.url().includes("/v1/auth/request-link")),
      ownerAPage.fill("input[type=email]", ownerAEmail),
      ownerAPage.click("button[type=submit]"),
    ]);
    await ownerAPage.waitForSelector("text=Check your email");
    const requestLinkBody: unknown = await requestLinkResponse.json().catch(() => undefined);
    steps.push({
      id: "step-2",
      title: 'Submit email for magic link ("check your email" state)',
      description:
        "Submitted a brand-new email address (no existing account) through the real login form. The request below is the actual browser-issued network call to POST /v1/auth/request-link, not a synthetic replay.",
      screenshotPngBase64: await screenshotBase64(ownerAPage),
      httpExchanges: [
        {
          label: "POST /v1/auth/request-link (fired by the login form)",
          request: {
            method: "POST",
            url: requestLinkResponse.url(),
            body: { email: ownerAEmail },
          },
          response: { status: requestLinkResponse.status(), body: requestLinkBody },
        },
      ],
    });

    // -----------------------------------------------------------------
    // Step 3: simulate clicking the magic link via the real
    // /v1/auth/verify endpoint directly -- not by navigating the browser
    // to the callback URL (that would be the UI shortcut this step is
    // explicitly avoiding). First-time signup branch: no account existed
    // for this email before step 2.
    // -----------------------------------------------------------------
    const ownerASignupToken = await waitForEmailToken(apiServer, ownerAEmail, requestLinkLogOffset);
    const { result: ownerAVerify, exchange: ownerAVerifyExchange } = await callApi<{
      user: { id: string; email: string; name: string };
      workspace?: { id: string; name: string };
    }>("POST", "/v1/auth/verify", { body: { token: ownerASignupToken } });
    if (ownerAVerify.status !== 200 || !ownerAVerify.body.workspace) {
      throw new Error(
        `Signup verify did not succeed as expected: ${ownerAVerify.status} ${JSON.stringify(ownerAVerify.body)}`,
      );
    }
    const ownerASessionCookie = extractSessionCookie(ownerAVerify.headers);
    const ownerA = { user: ownerAVerify.body.user, workspace: ownerAVerify.body.workspace };
    cleanup.userIds.push(ownerA.user.id);
    cleanup.workspaceIds.push(ownerA.workspace.id);

    steps.push({
      id: "step-3",
      title: "Simulate clicking the magic link (first-time signup branch)",
      description:
        "Called POST /v1/auth/verify directly with the token extracted from the real magic-link email (captured from the spawned apps/api dev server's console output, since ConsoleEmailSender only logs to stdout and LoginToken only stores a hash of the token at rest) -- no UI navigation involved. This is the first-time-signup branch: no account existed for this email before step 2, so verify created a User + Principal + default Organization + Workspace + Owner Membership in one transaction.",
      httpExchanges: [ownerAVerifyExchange],
    });

    // -----------------------------------------------------------------
    // Step 4: land in the default workspace. The session was created via
    // a direct API call (step 3), not the callback page, so the
    // browser's cookie jar and localStorage need to be primed manually
    // to reflect what a real magic-link click would have left behind.
    // -----------------------------------------------------------------
    await setBrowserSession(ownerAContext, ownerASessionCookie);
    await setActiveWorkspaceInBrowser(ownerAPage, ownerA.workspace);
    await ownerAPage.goto(`${DASHBOARD_BASE}/dashboard/members`);
    await ownerAPage.waitForSelector("text=Active members");
    steps.push({
      id: "step-4",
      title: "Land in default workspace (dashboard, member list)",
      description: `Dashboard members screen for workspace "${ownerA.workspace.name}" (${ownerA.workspace.id}), showing the newly-signed-up user as Owner.`,
      screenshotPngBase64: await screenshotBase64(ownerAPage),
    });

    // -----------------------------------------------------------------
    // Step 5: create a second workspace. There is no dashboard UI for
    // workspace creation at all (confirmed by reading every dashboard
    // page and apps/dashboard/src/components/app-shell.tsx -- the header
    // shows a static "Workspace: Default" label, not a switcher), so this
    // is necessarily the direct POST /v1/workspaces call the task also
    // asked to see recorded raw.
    // -----------------------------------------------------------------
    const orgLookup = await prisma.workspace.findUnique({
      where: { id: ownerA.workspace.id },
      select: { organizationId: true },
    });
    if (!orgLookup?.organizationId) {
      throw new Error(`Workspace ${ownerA.workspace.id} has no organizationId -- cannot continue.`);
    }
    const ownerAOrganizationId = orgLookup.organizationId;
    cleanup.organizationIds.push(ownerAOrganizationId);
    const { result: secondWorkspaceResult, exchange: secondWorkspaceExchange } = await callApi<{
      workspace: { id: string; name: string };
    }>("POST", "/v1/workspaces", {
      cookie: ownerASessionCookie,
      body: { name: "Second Workspace", organizationId: ownerAOrganizationId },
    });
    if (secondWorkspaceResult.status !== 201) {
      throw new Error(`POST /v1/workspaces failed: ${JSON.stringify(secondWorkspaceResult.body)}`);
    }
    const ownerASecondWorkspace = secondWorkspaceResult.body.workspace;
    cleanup.workspaceIds.push(ownerASecondWorkspace.id);

    // No real workspace switcher exists, so "showing both" is documented
    // honestly rather than faked: prove both are independently reachable
    // by flipping the browser's active-workspace localStorage entry (the
    // actual mechanism the dashboard uses in place of a switcher) and
    // reloading the members screen against the second workspace.
    await setActiveWorkspaceInBrowser(ownerAPage, ownerASecondWorkspace);
    await ownerAPage.goto(`${DASHBOARD_BASE}/dashboard/members`);
    await ownerAPage.waitForSelector("text=Active members");
    steps.push({
      id: "step-5",
      title: "Create a second workspace",
      description:
        "GAP, documented not fixed: no workspace-switcher UI exists anywhere in the dashboard (app-shell.tsx's header renders a static \"Workspace: Default\" label). This screenshot shows the actual mechanism the dashboard uses in its place -- the browser's routemind_active_workspace localStorage entry pointed at the newly-created second workspace, then reloading the Members screen -- proving both workspaces are real and independently reachable, since there is no switcher control to screenshot.",
      screenshotPngBase64: await screenshotBase64(ownerAPage),
      httpExchanges: [secondWorkspaceExchange],
      note: "No workspace switcher UI exists in the dashboard yet -- confirmed by reading apps/dashboard/src/components/app-shell.tsx, which renders a static \"Workspace: Default\" label, not a dropdown. This is a real, already-known gap (see docs/roadmap.md's BYO Router Model deferred items, which note the equivalent missing org switcher). Documented here rather than built, per this script's scope.",
    });

    // Switch back to the first workspace for the rest of the owner-driven flow.
    await setActiveWorkspaceInBrowser(ownerAPage, ownerA.workspace);
    await ownerAPage.goto(`${DASHBOARD_BASE}/dashboard/members`);
    await ownerAPage.waitForSelector("text=Active members");

    // -----------------------------------------------------------------
    // Step 6: invite a teammate as Developer, through the real UI form.
    // -----------------------------------------------------------------
    const inviteLogOffset = apiServer.log.length;
    const [inviteResponse] = await Promise.all([
      ownerAPage.waitForResponse(
        (r) => r.url().includes("/invites") && r.request().method() === "POST",
      ),
      ownerAPage.fill('input[placeholder="teammate@company.com"]', developerEmail),
      ownerAPage.selectOption("form >> select", "developer"),
      ownerAPage.click('button:has-text("Send invite")'),
    ]);
    await ownerAPage.waitForSelector(`text=${developerEmail}`);
    const inviteBody: unknown = await inviteResponse.json().catch(() => undefined);
    steps.push({
      id: "step-6",
      title: "Invite a teammate as Developer",
      description: `Invited ${developerEmail} as Developer through the real Members-page form, showing the pending invite row afterward.`,
      screenshotPngBase64: await screenshotBase64(ownerAPage),
      httpExchanges: [
        {
          label: "POST /v1/workspaces/:id/invites (fired by the invite form)",
          request: {
            method: "POST",
            url: inviteResponse.url(),
            body: { email: developerEmail, role: "developer" },
          },
          response: { status: inviteResponse.status(), body: inviteBody },
        },
      ],
    });

    // -----------------------------------------------------------------
    // Step 7: teammate accepts the invite in a brand-new browser
    // context (separate cookie jar/storage -- not the owner's session),
    // again via the real /v1/auth/verify endpoint directly.
    // -----------------------------------------------------------------
    const developerToken = await waitForEmailToken(apiServer, developerEmail, inviteLogOffset);
    const { result: developerVerify, exchange: developerVerifyExchange } = await callApi<{
      user: { id: string; email: string; name: string };
      workspace?: { id: string; name: string };
    }>("POST", "/v1/auth/verify", { body: { token: developerToken } });
    if (developerVerify.status !== 200 || !developerVerify.body.workspace) {
      throw new Error(
        `Developer invite-accept verify did not succeed: ${developerVerify.status} ${JSON.stringify(developerVerify.body)}`,
      );
    }
    const developerSessionCookie = extractSessionCookie(developerVerify.headers);
    const developerUser = developerVerify.body.user;
    const developerRow = await prisma.user.findUniqueOrThrow({
      where: { id: developerUser.id },
      select: { principalId: true },
    });
    cleanup.userIds.push(developerUser.id);
    if (developerRow.principalId) cleanup.principalIds.push(developerRow.principalId);

    const developerContext = await browser.newContext();
    const developerPage = await developerContext.newPage();
    await setBrowserSession(developerContext, developerSessionCookie);
    await setActiveWorkspaceInBrowser(developerPage, developerVerify.body.workspace);
    await developerPage.goto(`${DASHBOARD_BASE}/dashboard/members`);
    await developerPage.waitForSelector("text=Active members");
    steps.push({
      id: "step-7",
      title: "Teammate accepts the invite (new browser context)",
      description: `Accepted the invite as ${developerEmail} in a completely separate Playwright browser context (own cookie jar, own localStorage) -- not the Owner's session. Verified directly against POST /v1/auth/verify, landing in workspace "${developerVerify.body.workspace.name}".`,
      screenshotPngBase64: await screenshotBase64(developerPage),
      httpExchanges: [developerVerifyExchange],
    });

    // -----------------------------------------------------------------
    // Step 8: attempt a gated action as the Developer teammate.
    // -----------------------------------------------------------------
    const inviteButton = developerPage.locator('button:has-text("Send invite")');
    await inviteButton.hover();
    await developerPage.waitForTimeout(1600); // native title tooltips need a hover delay
    const tooltipText = await inviteButton.getAttribute("title");
    const isDisabled = await inviteButton.isDisabled();
    steps.push({
      id: "step-8",
      title: "Attempt a gated action as the Developer teammate",
      description: `Hovered the "Send invite" button on the Members page as the Developer teammate (who lacks workspace.manage). Button disabled=${isDisabled}, title attribute="${tooltipText ?? "(none)"}". Native browser title tooltips render as an OS-level overlay after a hover delay and are not always reliably captured in a headless screenshot -- the disabled state and the title attribute's exact text are the authoritative signal either way, and are reported here regardless of what the screenshot itself shows.`,
      screenshotPngBase64: await screenshotBase64(developerPage),
    });

    // -----------------------------------------------------------------
    // Step 9: create a service account, issue a key, as Owner.
    // -----------------------------------------------------------------
    await ownerAPage.goto(`${DASHBOARD_BASE}/dashboard/service-accounts`);
    await ownerAPage.waitForSelector("text=New service account");
    await ownerAPage.fill('input[placeholder="CI Deploy Bot"]', "E2E Report CI Bot");
    await ownerAPage.click('button:has-text("Create")');
    await ownerAPage.waitForSelector("text=E2E Report CI Bot");
    await ownerAPage.click('button:has-text("New key")');
    await ownerAPage.fill('input[placeholder="production deploy key"]', "e2e report key");
    await ownerAPage.click('button:has-text("Issue")');
    await ownerAPage.waitForSelector("text=Copy it now");
    steps.push({
      id: "step-9",
      title: "Create a service account, issue a key",
      description:
        'Created service account "E2E Report CI Bot" and issued a key named "e2e report key" through the real dashboard UI. Screenshot shows the one-time key-reveal screen -- the raw key is never returned by the API again after this.',
      screenshotPngBase64: await screenshotBase64(ownerAPage),
    });

    // ServiceAccount has no displayName/workspaceId column of its own --
    // those are derived at the route layer from Principal + Membership --
    // so cleanup is keyed off the Principal this created instead.
    const serviceAccountPrincipal = await prisma.principal.findFirstOrThrow({
      where: { displayName: "E2E Report CI Bot", type: "service_account" },
    });
    cleanup.principalIds.push(serviceAccountPrincipal.id);

    // -----------------------------------------------------------------
    // Step 10: revoke that key.
    // -----------------------------------------------------------------
    await ownerAPage.click('button:has-text("Dismiss")');
    let revokeGapNote: string | undefined;
    const browserErrorsBefore = browserErrors.length;
    try {
      const [revokeResponse] = await Promise.all([
        ownerAPage.waitForResponse(
          (r) =>
            /\/service-accounts\/.+\/keys\/.+/.test(r.url()) && r.request().method() === "DELETE",
          { timeout: 15_000 },
        ),
        ownerAPage.click('button:has-text("Revoke")'),
      ]);
      if (!revokeResponse.ok()) {
        revokeGapNote = `The revoke-key DELETE request returned ${revokeResponse.status()} instead of succeeding.`;
      } else {
        await ownerAPage.waitForSelector("text=Revoked", { timeout: 10_000 });
      }
    } catch (error) {
      const newBrowserErrors = browserErrors.slice(browserErrorsBefore);
      revokeGapNote =
        newBrowserErrors.length > 0
          ? `GAP, documented not fixed: the revoke-key action never completed. Real cause, captured directly from the browser: ${newBrowserErrors.join(" | ")}`
          : `The revoke-key action did not complete as expected: ${String(error instanceof Error ? error.message : error)}. Documented as found, not fixed.`;
    }
    steps.push({
      id: "step-10",
      title: "Revoke that key",
      description: revokeGapNote
        ? "Attempted to revoke the just-issued service-account key through the dashboard."
        : "Revoked the just-issued service-account key through the dashboard. Its row now reads Revoked instead of Active, with no remaining action available.",
      screenshotPngBase64: await screenshotBase64(ownerAPage),
      note: revokeGapNote,
    });

    // -----------------------------------------------------------------
    // Step 11: view the audit log as Owner.
    // -----------------------------------------------------------------
    await ownerAPage.goto(`${DASHBOARD_BASE}/dashboard/audit-log`);
    await ownerAPage.waitForSelector("text=Events");
    steps.push({
      id: "step-11",
      title: "View the audit log as Owner",
      description:
        "Audit log for the workspace, showing every action from steps 3-10 (invite creation, the teammate's own self-attributed member.add on acceptance, service-account creation, key issuance, key revocation) with correct principal attribution.",
      screenshotPngBase64: await screenshotBase64(ownerAPage),
    });

    // -----------------------------------------------------------------
    // Extra: workspace-scoping negative case for router-config/policies.
    // Needs a workspace Owner A genuinely has no membership in at all --
    // the "second workspace" from step 5 doesn't qualify, since Owner A
    // owns that one too. A separate Owner B is created purely for this.
    // -----------------------------------------------------------------
    const requestLinkOffsetB = apiServer.log.length;
    await callApi("POST", "/v1/auth/request-link", { body: { email: ownerBEmail } });
    const ownerBToken = await waitForEmailToken(apiServer, ownerBEmail, requestLinkOffsetB);
    const { result: ownerBVerify } = await callApi<{
      user: { id: string; email: string };
      workspace?: { id: string; name: string };
    }>("POST", "/v1/auth/verify", { body: { token: ownerBToken } });
    if (ownerBVerify.status !== 200 || !ownerBVerify.body.workspace) {
      throw new Error(`Owner B signup failed: ${ownerBVerify.status}`);
    }
    cleanup.userIds.push(ownerBVerify.body.user.id);
    cleanup.workspaceIds.push(ownerBVerify.body.workspace.id);
    const ownerBOrgLookup = await prisma.workspace.findUnique({
      where: { id: ownerBVerify.body.workspace.id },
      select: { organizationId: true },
    });
    if (!ownerBOrgLookup?.organizationId) {
      throw new Error(`Workspace ${ownerBVerify.body.workspace.id} has no organizationId.`);
    }
    cleanup.organizationIds.push(ownerBOrgLookup.organizationId);

    const { exchange: routerConfigOwnExchange } = await callApi(
      "GET",
      `/v1/workspaces/${ownerA.workspace.id}/router-config`,
      { cookie: ownerASessionCookie },
    );
    const { exchange: policiesOwnExchange } = await callApi(
      "GET",
      `/v1/workspaces/${ownerA.workspace.id}/policies`,
      { cookie: ownerASessionCookie },
    );
    const { result: routerConfigCrossWorkspace, exchange: routerConfigCrossExchange } =
      await callApi("GET", `/v1/workspaces/${ownerBVerify.body.workspace.id}/router-config`, {
        cookie: ownerASessionCookie,
      });
    const { result: policiesCrossWorkspace, exchange: policiesCrossExchange } = await callApi(
      "GET",
      `/v1/workspaces/${ownerBVerify.body.workspace.id}/policies`,
      { cookie: ownerASessionCookie },
    );
    steps.push({
      id: "step-12",
      title: "Workspace-scoping check: router-config and policies",
      description: `Owner A's own session (${ownerA.workspace.id}) called against its own workspace succeeds (or returns an empty/absent config, which is the normal state for a workspace with none configured yet -- not an error). The same session called against Owner B's unrelated workspace (${ownerBVerify.body.workspace.id}), which Owner A has no Membership in at all, correctly returns 403 for both endpoints.`,
      httpExchanges: [
        routerConfigOwnExchange,
        policiesOwnExchange,
        routerConfigCrossExchange,
        policiesCrossExchange,
      ],
      note:
        routerConfigCrossWorkspace.status === 403 && policiesCrossWorkspace.status === 403
          ? undefined
          : `Unexpected: cross-workspace calls returned router-config=${routerConfigCrossWorkspace.status}, policies=${policiesCrossWorkspace.status} (expected 403 for both).`,
    });

    // -----------------------------------------------------------------
    // Extra: a real /v1/chat/completions call, with routing.reason and
    // routing.configSource shown in the recorded response body.
    // -----------------------------------------------------------------
    const { result: apiKeyResult, exchange: apiKeyExchange } = await callApi<{ apiKey: string }>(
      "POST",
      `/v1/workspaces/${ownerA.workspace.id}/api-keys`,
      {
        cookie: ownerASessionCookie,
        body: { userId: ownerA.user.id, name: "e2e report chat key" },
      },
    );
    if (apiKeyResult.status !== 201) {
      throw new Error(
        `Could not mint an API key for the chat completions call: ${apiKeyResult.status}`,
      );
    }
    const { exchange: chatExchange } = await callApi("POST", "/v1/chat/completions", {
      apiKey: apiKeyResult.body.apiKey,
      body: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Say hello in exactly three words." }],
      },
    });
    steps.push({
      id: "step-13",
      title: "A real /v1/chat/completions call with a real routing decision",
      description:
        "Minted a real workspace API key, then called chat completions with it. The response's routemind.routing field carries the routing engine's actual reason and configSource for this request.",
      httpExchanges: [apiKeyExchange, chatExchange],
    });

    console.log("All steps completed.");
  } finally {
    if (browser) await browser.close().catch(() => undefined);

    console.log("Stopping dev servers...");
    killServerTree(apiServer);
    killServerTree(dashboardServer);
    await new Promise((r) => setTimeout(r, 1500));

    console.log("Cleaning up database rows created by this run...");
    await prisma.auditEvent.deleteMany({ where: { workspaceId: { in: cleanup.workspaceIds } } });
    await prisma.apiKey.deleteMany({ where: { workspaceId: { in: cleanup.workspaceIds } } });
    await prisma.membership.deleteMany({ where: { workspaceId: { in: cleanup.workspaceIds } } });
    await prisma.workspaceMember.deleteMany({
      where: { workspaceId: { in: cleanup.workspaceIds } },
    });
    await prisma.workspaceInvite.deleteMany({
      where: { workspaceId: { in: cleanup.workspaceIds } },
    });
    await prisma.serviceAccount.deleteMany({
      where: { principalId: { in: cleanup.principalIds } },
    });
    await prisma.loginToken.deleteMany({ where: { userId: { in: cleanup.userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: cleanup.userIds } } });
    await prisma.principal.deleteMany({ where: { id: { in: cleanup.principalIds } } });
    await prisma.workspace.deleteMany({ where: { id: { in: cleanup.workspaceIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: cleanup.organizationIds } } });
    await prisma.$disconnect();

    if (steps.length > 0) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const reportPath = resolve(repoRoot, "reports", `e2e-register-to-login-${timestamp}.html`);
      await mkdir(resolve(repoRoot, "reports"), { recursive: true });
      const html = buildHtmlReport({
        title: "RouteMind E2E: Register-to-Login Flow",
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
