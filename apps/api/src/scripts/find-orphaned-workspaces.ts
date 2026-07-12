import { PrismaClient } from "@prisma/client";

import { loadConfig } from "../config.js";

loadConfig();
const prisma = new PrismaClient();

interface OrphanFinding {
  readonly workspaceId: string;
  readonly name: string;
  readonly slug: string;
  readonly organizationId: string | null;
  readonly createdAt: Date;
  readonly reason: string;
}

/**
 * Read-only scan for Workspace rows left behind by the pre-fix
 * POST /v1/workspaces bug (crashed with a 500 after inserting the Workspace
 * row but before adding its owner, because the caller-supplied ownerUserId
 * defaulted to a nonexistent "dev-user"). Reports findings only -- does not
 * delete anything, since a false positive here would destroy real data.
 */
async function main(): Promise<void> {
  const workspaces = await prisma.workspace.findMany({
    select: { id: true, name: true, slug: true, organizationId: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  const findings: OrphanFinding[] = [];

  for (const workspace of workspaces) {
    const [membershipCount, legacyMemberCount] = await Promise.all([
      prisma.membership.count({ where: { workspaceId: workspace.id } }),
      prisma.workspaceMember.count({ where: { workspaceId: workspace.id } }),
    ]);

    if (membershipCount === 0 && legacyMemberCount === 0) {
      findings.push({
        workspaceId: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
        organizationId: workspace.organizationId,
        createdAt: workspace.createdAt,
        reason:
          "no Membership and no legacy WorkspaceMember row -- likely orphaned by the pre-fix " +
          "POST /v1/workspaces bug (Workspace row created, then the request crashed before an " +
          "owner could be attached).",
      });
    }
  }

  console.log(`Scanned ${workspaces.length} workspace(s).`);

  if (findings.length === 0) {
    console.log("No orphaned workspaces found.");
    return;
  }

  console.log(`Found ${findings.length} orphaned workspace(s):\n`);
  for (const finding of findings) {
    console.log(
      `  - ${finding.workspaceId} ("${finding.name}", slug=${finding.slug}, ` +
        `organizationId=${finding.organizationId ?? "null"}, createdAt=${finding.createdAt.toISOString()})\n` +
        `    ${finding.reason}`,
    );
  }
  console.log("\nNothing was deleted. Review each row above and clean up manually once confirmed.");
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
