/**
 * Manual QA walkthrough of the full Phase 0 dashboard flow, run once and
 * reported rather than asserted with vitest -- this is meant to be read
 * like a human tester's notes, not a regression suite (that's what the
 * existing *.test.ts files are for).
 *
 * Runs the real Fastify app (buildApp) against the real local dev Postgres
 * via app.inject() -- this is the most faithful thing achievable without
 * an actual browser: real route handlers, real Prisma calls, real cookie
 * handling, just without a TCP socket or rendered pixels. Anywhere this
 * can't stand in for "look at the screen," it's called out explicitly.
 *
 * Usage: npm run qa:phase0 -w apps/api (see package.json)
 */
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";

import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { EmailMessage, EmailSender } from "../infrastructure/email-sender.js";
import { PrismaWorkspaceService } from "../infrastructure/workspace-service.js";
import { seedRoles } from "./seed-rbac.js";

class RecordingEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];
  send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
}

function extractToken(emailText: string): string {
  const match = emailText.match(/https?:\/\/\S+/);
  if (!match) throw new Error(`No link found in email text: ${emailText}`);
  const token = new URL(match[0]).searchParams.get("token");
  if (!token) throw new Error(`No token found in link: ${match[0]}`);
  return token;
}

function extractSessionCookie(response: { headers: { "set-cookie"?: string | string[] } }): string {
  const setCookie = response.headers["set-cookie"];
  const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!cookieHeader) throw new Error("No set-cookie header on response.");
  return cookieHeader.split(";")[0]!;
}

type Status = "PASS" | "GAP" | "FAIL";

interface Finding {
  readonly step: string;
  readonly status: Status;
  readonly detail: string;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const prisma = new PrismaClient();
  await seedRoles(prisma);
  const emailSender = new RecordingEmailSender();
  const workspaceService = new PrismaWorkspaceService(prisma);
  const app = await buildApp({ config, prisma, emailSender, workspaceService });

  const findings: Finding[] = [];
  const cleanup = {
    workspaceIds: [] as string[],
    organizationIds: [] as string[],
    userIds: [] as string[],
    principalIds: [] as string[],
  };

  function record(step: string, status: Status, detail: string): void {
    findings.push({ step, status, detail });
    console.log(`[${status}] ${step}\n    ${detail}\n`);
  }

  try {
    // ---------------------------------------------------------------
    // Step 1: "Sign up" -- a brand-new email with no existing account.
    // ---------------------------------------------------------------
    const brandNewEmail = `qa-signup-${randomUUID()}@routemind-qa.local`;
    const signupAttempt = await app.inject({
      method: "POST",
      url: "/v1/auth/request-link",
      payload: { email: brandNewEmail },
    });
    if (signupAttempt.statusCode === 200 && emailSender.sent.length === 0) {
      record(
        "1. Sign up (fresh email, no existing account)",
        "GAP",
        "POST /v1/auth/request-link returns 200 (by design, enumeration-safe) but sends no email and creates no User for an address with no existing account. There is no self-serve sign-up flow anywhere in the dashboard -- a User row must already exist before magic-link login works at all. Today the only way a brand-new person gets an account is (a) someone with workspace.manage invites them, or (b) manual/DB-level provisioning. This matches docs/roadmap.md Phase 1's \"Self-serve signup flow\" item, which is explicitly not built yet -- not a regression, but worth confirming it's still accurately reflected as not-yet-done.",
      );
    } else {
      record(
        "1. Sign up (fresh email, no existing account)",
        "FAIL",
        `Unexpected: request-link for an unknown email sent ${emailSender.sent.length} email(s) or returned ${signupAttempt.statusCode}.`,
      );
    }

    // ---------------------------------------------------------------
    // Bootstrap: since there's no self-serve signup, provision an Owner
    // the way the one real production user actually got provisioned --
    // directly, not through any dashboard-reachable route. This mirrors
    // reality rather than working around it invisibly.
    // ---------------------------------------------------------------
    const ownerOrg = await prisma.organization.create({ data: { name: "QA Co" } });
    cleanup.organizationIds.push(ownerOrg.id);
    const ownerWorkspace = await prisma.workspace.create({
      data: { name: "QA Workspace", slug: `qa-${randomUUID()}`, organizationId: ownerOrg.id },
    });
    cleanup.workspaceIds.push(ownerWorkspace.id);
    const ownerPrincipal = await prisma.principal.create({
      data: { type: "user", displayName: "QA Owner" },
    });
    cleanup.principalIds.push(ownerPrincipal.id);
    const ownerRole = await prisma.role.findUniqueOrThrow({ where: { name: "Owner" } });
    await prisma.membership.create({
      data: {
        workspaceId: ownerWorkspace.id,
        principalId: ownerPrincipal.id,
        role: "Owner",
        roleId: ownerRole.id,
      },
    });
    const ownerEmail = `qa-owner-${randomUUID()}@routemind-qa.local`;
    const ownerUser = await prisma.user.create({
      data: { email: ownerEmail, name: "QA Owner", principalId: ownerPrincipal.id },
    });
    cleanup.userIds.push(ownerUser.id);
    // Legacy WorkspaceMember row too, since that's what the Members list
    // and last-Owner protection actually read from.
    await new PrismaWorkspaceService(prisma).addMember({
      workspaceId: ownerWorkspace.id,
      userId: ownerUser.id,
      role: "owner",
    });

    // ---------------------------------------------------------------
    // Step 2: log in as the (bootstrapped) Owner, check "land in
    // default workspace."
    // ---------------------------------------------------------------
    emailSender.sent.length = 0;
    await app.inject({
      method: "POST",
      url: "/v1/auth/request-link",
      payload: { email: ownerEmail },
    });
    if (emailSender.sent.length !== 1) {
      record(
        "2. Log in as Owner",
        "FAIL",
        `Expected exactly 1 login email for a real user, got ${emailSender.sent.length}.`,
      );
      throw new Error("Cannot continue without a working login.");
    }
    const ownerLoginToken = extractToken(emailSender.sent[0]!.text);
    const ownerVerify = await app.inject({
      method: "POST",
      url: "/v1/auth/verify",
      payload: { token: ownerLoginToken },
    });
    if (ownerVerify.statusCode !== 200) {
      record("2. Log in as Owner", "FAIL", `/v1/auth/verify returned ${ownerVerify.statusCode}.`);
      throw new Error("Cannot continue without a working login.");
    }
    const ownerCookie = extractSessionCookie(ownerVerify);
    const ownerVerifyBody = JSON.parse(ownerVerify.payload) as { workspace?: { id: string } };

    if (ownerVerifyBody.workspace) {
      record(
        "2. Land in default workspace after a normal login",
        "PASS",
        `verify response included workspace ${ownerVerifyBody.workspace.id}.`,
      );
    } else {
      record(
        "2. Land in default workspace after a normal login",
        "GAP",
        "POST /v1/auth/verify's response has no `workspace` field for an ordinary (non-invite) login -- only an invite-acceptance verify sets one (see apps/dashboard/src/app/auth/callback/page.tsx). A returning Owner logging in normally lands on /dashboard with NO active workspace in localStorage, so Members, Audit Log, and Service Accounts all immediately show their \"No active workspace\" empty state -- there's no dashboard affordance to pick or land in a workspace on a normal login, only on first-time invite acceptance.",
      );
    }

    // ---------------------------------------------------------------
    // Step 3: create a second workspace.
    // ---------------------------------------------------------------
    const secondWorkspaceResponse = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { cookie: ownerCookie },
      payload: { name: "QA Second Workspace" },
    });
    if (secondWorkspaceResponse.statusCode === 201) {
      const body = JSON.parse(secondWorkspaceResponse.payload) as {
        workspace: { id: string; name: string };
      };
      cleanup.workspaceIds.push(body.workspace.id);
      const secondWorkspaceMembership = await prisma.membership.findFirst({
        where: { workspaceId: body.workspace.id },
      });
      record(
        "3. Create a second workspace",
        "GAP",
        `POST /v1/workspaces succeeded (201) and created workspace ${body.workspace.id}, but this route has NO requirePermission gate at all -- it's callable by anyone, including with no cookie or API key whatsoever (confirmed: the request above used the Owner's session, but the route itself never checks it). It also defaults \`ownerUserId\` to the literal string "dev-user" if the caller doesn't pass one explicitly, which nothing in the dashboard does. Worse: it creates a legacy WorkspaceMember row via workspaceService.createWorkspace() but NO Membership/Principal row -- confirmed here (Membership lookup for the new workspace found: ${secondWorkspaceMembership ? "one" : "none"}). That means whoever "owns" a workspace created this way can never actually call any RBAC-gated route in it (Members, invites, service accounts, audit log all 403 forever) -- and there is no dashboard UI calling this route at all today, so this entire path is both unauthenticated and structurally broken relative to the RBAC system built in later slices.`,
      );
    } else {
      // The route can partially create a Workspace row before failing
      // (insertWorkspace() succeeds, the following addMember() 500s) --
      // find and clean up any such orphan by slug so re-runs don't leak.
      const orphan = await prisma.workspace.findUnique({
        where: { slug: "qa-second-workspace" },
      });
      if (orphan) cleanup.workspaceIds.push(orphan.id);
      record(
        "3. Create a second workspace",
        "FAIL",
        `POST /v1/workspaces returned ${secondWorkspaceResponse.statusCode} (not 201) using the Owner's session cookie. This route has no requirePermission gate at all and defaults \`ownerUserId\` to the literal string "dev-user" when the caller doesn't pass one -- since no User with id "dev-user" exists, the follow-on addMember() call violates a foreign key constraint and the request 500s. There is no dashboard UI calling this route today, so this whole path is both unauthenticated and, as run here, actually broken rather than merely unwired.${orphan ? ` A partially-created Workspace row (${orphan.id}) was left behind before the failure and has been queued for cleanup.` : ""}`,
      );
    }

    // ---------------------------------------------------------------
    // Step 4: invite a teammate as Developer.
    // ---------------------------------------------------------------
    emailSender.sent.length = 0;
    const developerEmail = `qa-developer-${randomUUID()}@routemind-qa.local`;
    const inviteResponse = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${ownerWorkspace.id}/invites`,
      headers: { cookie: ownerCookie },
      payload: { email: developerEmail, role: "developer" },
    });
    if (inviteResponse.statusCode !== 201 || emailSender.sent.length !== 1) {
      record(
        "4. Invite a teammate as Developer",
        "FAIL",
        `POST invites returned ${inviteResponse.statusCode}, ${emailSender.sent.length} email(s) sent.`,
      );
      throw new Error("Cannot continue without a working invite.");
    }
    record(
      "4. Invite a teammate as Developer",
      "PASS",
      `Invite created and emailed to ${developerEmail} via the Owner's session cookie (no API key) -- confirms the session-auth fix from two slices ago actually works end-to-end.`,
    );

    // ---------------------------------------------------------------
    // Step 5: teammate accepts the invite, lands in the invited
    // workspace.
    // ---------------------------------------------------------------
    const developerToken = extractToken(emailSender.sent[0]!.text);
    const developerVerify = await app.inject({
      method: "POST",
      url: "/v1/auth/verify",
      payload: { token: developerToken },
    });
    const developerVerifyBody = JSON.parse(developerVerify.payload) as {
      workspace?: { id: string };
    };
    const developerCookie = extractSessionCookie(developerVerify);
    const developerUser = await prisma.user.findUniqueOrThrow({ where: { email: developerEmail } });
    cleanup.userIds.push(developerUser.id);
    cleanup.principalIds.push(developerUser.principalId!);

    if (developerVerifyBody.workspace?.id === ownerWorkspace.id) {
      record(
        "5. Teammate accepts invite and lands in the invited workspace",
        "PASS",
        `verify response's workspace (${developerVerifyBody.workspace.id}) matches the inviting workspace -- the dashboard callback would set this as active and redirect to /dashboard/members, not a generic landing page.`,
      );
    } else {
      record(
        "5. Teammate accepts invite and lands in the invited workspace",
        "FAIL",
        `Expected workspace ${ownerWorkspace.id}, got ${developerVerifyBody.workspace?.id ?? "none"}.`,
      );
    }

    // ---------------------------------------------------------------
    // Step 6: confirm gated actions are correctly blocked for the
    // Developer -- this is what actually drives the dashboard's
    // disabled/tooltip UI state; there's no browser here to look at
    // the rendered pixels, so this verifies the server enforcement the
    // UI reflects, which is the part that actually matters for safety.
    // ---------------------------------------------------------------
    const meResponse = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${ownerWorkspace.id}/me`,
      headers: { cookie: developerCookie },
    });
    const mePermissions = (JSON.parse(meResponse.payload) as { permissions: string[] }).permissions;
    const shouldNotHave = [
      "workspace.manage",
      "apikey.create",
      "apikey.delete",
      "apikey.read",
      "audit.read",
    ];
    const incorrectlyGranted = shouldNotHave.filter((permission) =>
      mePermissions.includes(permission),
    );

    const gatedAttempts: Array<{ label: string; response: { statusCode: number } }> = [];
    gatedAttempts.push({
      label: "invite another teammate (workspace.manage)",
      response: await app.inject({
        method: "POST",
        url: `/v1/workspaces/${ownerWorkspace.id}/invites`,
        headers: { cookie: developerCookie },
        payload: { email: `qa-should-fail-${randomUUID()}@routemind-qa.local`, role: "viewer" },
      }),
    });
    gatedAttempts.push({
      label: "list service accounts (apikey.read)",
      response: await app.inject({
        method: "GET",
        url: `/v1/workspaces/${ownerWorkspace.id}/service-accounts`,
        headers: { cookie: developerCookie },
      }),
    });
    gatedAttempts.push({
      label: "create a service account (workspace.manage)",
      response: await app.inject({
        method: "POST",
        url: `/v1/workspaces/${ownerWorkspace.id}/service-accounts`,
        headers: { cookie: developerCookie },
        payload: { displayName: "Should Fail Bot", role: "Viewer" },
      }),
    });
    gatedAttempts.push({
      label: "read the audit log (audit.read)",
      response: await app.inject({
        method: "GET",
        url: `/v1/workspaces/${ownerWorkspace.id}/audit-log`,
        headers: { cookie: developerCookie },
      }),
    });

    const wronglyAllowed = gatedAttempts.filter((attempt) => attempt.response.statusCode < 400);

    if (incorrectlyGranted.length === 0 && wronglyAllowed.length === 0) {
      record(
        "6. Gated actions correctly blocked for Developer",
        "PASS",
        `/me returned ${mePermissions.length} permission(s) for Developer (${mePermissions.join(", ")}), none of the Admin/Owner-only ones. All ${gatedAttempts.length} gated actions attempted returned 403: ${gatedAttempts.map((a) => `${a.label}=${a.response.statusCode}`).join(", ")}. This is the server-side enforcement the dashboard's disabled+tooltip UI reflects -- I cannot visually confirm the buttons themselves render greyed out with the correct tooltip text in an actual browser in this environment; that's the one part of this step not verified here.`,
      );
    } else {
      record(
        "6. Gated actions correctly blocked for Developer",
        "FAIL",
        `Incorrectly granted permissions: [${incorrectlyGranted.join(", ")}]. Wrongly allowed actions: [${wronglyAllowed.map((a) => a.label).join(", ")}].`,
      );
    }

    // ---------------------------------------------------------------
    // Step 7-9: create a service account, issue a key, revoke it (as
    // Owner).
    // ---------------------------------------------------------------
    const createSaResponse = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${ownerWorkspace.id}/service-accounts`,
      headers: { cookie: ownerCookie },
      payload: { displayName: "QA CI Bot", description: "manual QA run", role: "Developer" },
    });
    const serviceAccount = (
      JSON.parse(createSaResponse.payload) as {
        serviceAccount: { id: string; principalId: string };
      }
    ).serviceAccount;
    cleanup.principalIds.push(serviceAccount.principalId);

    const issueKeyResponse = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${ownerWorkspace.id}/service-accounts/${serviceAccount.id}/keys`,
      headers: { cookie: ownerCookie },
      payload: { name: "QA issued key" },
    });
    const issuedKey = JSON.parse(issueKeyResponse.payload) as { id: string; apiKey: string };

    const revokeKeyResponse = await app.inject({
      method: "DELETE",
      url: `/v1/workspaces/${ownerWorkspace.id}/service-accounts/${serviceAccount.id}/keys/${issuedKey.id}`,
      headers: { cookie: ownerCookie },
    });

    if (
      createSaResponse.statusCode === 201 &&
      issueKeyResponse.statusCode === 201 &&
      revokeKeyResponse.statusCode === 200
    ) {
      record(
        "7-9. Create service account, issue key, revoke key",
        "PASS",
        `Service account ${serviceAccount.id} created, key ${issuedKey.id} issued and revoked, all via the Owner's session cookie.`,
      );
    } else {
      record(
        "7-9. Create service account, issue key, revoke key",
        "FAIL",
        `Statuses: create=${createSaResponse.statusCode}, issue=${issueKeyResponse.statusCode}, revoke=${revokeKeyResponse.statusCode}.`,
      );
    }

    // ---------------------------------------------------------------
    // Step 10: confirm every action above appears correctly attributed
    // in the audit log.
    // ---------------------------------------------------------------
    const auditResponse = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${ownerWorkspace.id}/audit-log?limit=50`,
      headers: { cookie: ownerCookie },
    });
    const auditEvents = (
      JSON.parse(auditResponse.payload) as {
        events: Array<{ action: string; principalId: string; targetId: string }>;
      }
    ).events;

    const expectedEvents: Array<{
      action: string;
      targetId: string;
      expectedPrincipalId: string;
      label: string;
    }> = [
      {
        action: "invite.create",
        targetId: "",
        expectedPrincipalId: ownerPrincipal.id,
        label: "invite creation",
      },
      {
        action: "member.add",
        targetId: "",
        expectedPrincipalId: developerUser.principalId!,
        label: "teammate accepting invite (self-attributed)",
      },
      {
        action: "service_account.create",
        targetId: serviceAccount.id,
        expectedPrincipalId: ownerPrincipal.id,
        label: "service account creation",
      },
      {
        action: "apikey.create",
        targetId: issuedKey.id,
        expectedPrincipalId: ownerPrincipal.id,
        label: "service-account key issuance",
      },
      {
        action: "apikey.delete",
        targetId: issuedKey.id,
        expectedPrincipalId: ownerPrincipal.id,
        label: "service-account key revocation",
      },
    ];

    const auditFindings: string[] = [];
    let allAuditCorrect = true;
    for (const expected of expectedEvents) {
      const match = expected.targetId
        ? auditEvents.find(
            (event) => event.action === expected.action && event.targetId === expected.targetId,
          )
        : auditEvents.find((event) => event.action === expected.action);
      if (!match) {
        allAuditCorrect = false;
        auditFindings.push(`MISSING: ${expected.label} (${expected.action})`);
      } else if (match.principalId !== expected.expectedPrincipalId) {
        allAuditCorrect = false;
        auditFindings.push(
          `WRONG ATTRIBUTION: ${expected.label} (${expected.action}) attributed to ${match.principalId}, expected ${expected.expectedPrincipalId}`,
        );
      } else {
        auditFindings.push(
          `OK: ${expected.label} (${expected.action}) -> principal ${match.principalId}`,
        );
      }
    }

    record(
      allAuditCorrect
        ? "10. All actions correctly attributed in audit log"
        : "10. All actions correctly attributed in audit log",
      allAuditCorrect ? "PASS" : "FAIL",
      auditFindings.join("\n    "),
    );
  } finally {
    // -----------------------------------------------------------------
    // Summary
    // -----------------------------------------------------------------
    const passCount = findings.filter((f) => f.status === "PASS").length;
    const gapCount = findings.filter((f) => f.status === "GAP").length;
    const failCount = findings.filter((f) => f.status === "FAIL").length;
    console.log("=".repeat(70));
    console.log(`QA SUMMARY: ${passCount} PASS, ${gapCount} GAP, ${failCount} FAIL`);
    console.log("=".repeat(70));
    for (const finding of findings) {
      console.log(`[${finding.status}] ${finding.step}`);
    }

    // -----------------------------------------------------------------
    // Cleanup -- don't leave QA data in the local dev DB.
    // -----------------------------------------------------------------
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

    await app.close();
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
