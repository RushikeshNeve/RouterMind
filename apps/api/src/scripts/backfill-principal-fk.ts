import { PrismaClient } from "@prisma/client";

import { loadConfig } from "../config.js";

loadConfig();
const prisma = new PrismaClient();

async function backfillUserPrincipal(): Promise<{ updated: number; unresolved: number }> {
  const users = await prisma.user.findMany({
    where: { principalId: null },
    select: { id: true },
  });

  let updated = 0;
  let unresolved = 0;

  for (const user of users) {
    const workspace = await prisma.workspace.findUnique({
      where: { slug: `personal-${user.id}` },
      select: { id: true },
    });

    if (!workspace) {
      unresolved += 1;
      console.warn(
        `[User] no personal workspace found for userId=${user.id} — left principalId NULL. Run backfill-tenancy.ts for this user first.`,
      );
      continue;
    }

    const ownerMembership = await prisma.membership.findFirst({
      where: { workspaceId: workspace.id, role: "Owner" },
      select: { principalId: true },
    });

    if (!ownerMembership) {
      unresolved += 1;
      console.warn(
        `[User] personal workspace found but no Owner Membership for userId=${user.id} — left principalId NULL. Run backfill-tenancy.ts for this user first.`,
      );
      continue;
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { principalId: ownerMembership.principalId },
    });
    updated += 1;
  }

  return { updated, unresolved };
}

async function backfillApiKeyPrincipal(): Promise<{ updated: number; unresolved: number }> {
  const apiKeys = await prisma.apiKey.findMany({
    where: { principalId: null },
    select: { id: true, userId: true },
  });

  let updated = 0;
  let unresolved = 0;

  for (const apiKey of apiKeys) {
    const user = await prisma.user.findUnique({
      where: { id: apiKey.userId },
      select: { principalId: true },
    });

    if (!user?.principalId) {
      unresolved += 1;
      console.warn(
        `[ApiKey] user ${apiKey.userId} has no principalId yet — left ApiKey ${apiKey.id} principalId NULL.`,
      );
      continue;
    }

    await prisma.apiKey.update({
      where: { id: apiKey.id },
      data: { principalId: user.principalId },
    });
    updated += 1;
  }

  return { updated, unresolved };
}

async function main(): Promise<void> {
  const userResult = await backfillUserPrincipal();
  console.log(
    `User.principalId: updated ${userResult.updated}, unresolved ${userResult.unresolved}.`,
  );

  const apiKeyResult = await backfillApiKeyPrincipal();
  console.log(
    `ApiKey.principalId: updated ${apiKeyResult.updated}, unresolved ${apiKeyResult.unresolved}.`,
  );

  const [remainingUserNull, remainingApiKeyNull] = await Promise.all([
    prisma.user.count({ where: { principalId: null } }),
    prisma.apiKey.count({ where: { principalId: null } }),
  ]);

  console.log(
    `Remaining NULL principalId — User: ${remainingUserNull}, ApiKey: ${remainingApiKeyNull}.`,
  );

  if (remainingUserNull > 0 || remainingApiKeyNull > 0) {
    console.warn(
      "Not all rows have a non-null principalId yet. Do NOT proceed to make principalId required or drop userId until this is zero.",
    );
  }
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
