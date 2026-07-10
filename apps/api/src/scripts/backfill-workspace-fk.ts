import { PrismaClient } from "@prisma/client";

import { loadConfig } from "../config.js";

loadConfig();
const prisma = new PrismaClient();

interface BackfillResult {
  table: string;
  updated: number;
  unresolved: number;
}

async function backfillApiKey(): Promise<BackfillResult> {
  const rows = await prisma.apiKey.findMany({
    where: { workspaceId: null },
    select: { id: true, userId: true },
  });
  return applyBackfill("ApiKey", rows, (id, workspaceId) =>
    prisma.apiKey.update({ where: { id }, data: { workspaceId } }),
  );
}

async function backfillProviderCredential(): Promise<BackfillResult> {
  const rows = await prisma.providerCredential.findMany({
    where: { workspaceId: null },
    select: { id: true, userId: true },
  });
  return applyBackfill("ProviderCredential", rows, (id, workspaceId) =>
    prisma.providerCredential.update({ where: { id }, data: { workspaceId } }),
  );
}

async function backfillUserModelAccess(): Promise<BackfillResult> {
  const rows = await prisma.userModelAccess.findMany({
    where: { workspaceId: null },
    select: { id: true, userId: true },
  });
  return applyBackfill("UserModelAccess", rows, (id, workspaceId) =>
    prisma.userModelAccess.update({ where: { id }, data: { workspaceId } }),
  );
}

async function applyBackfill(
  table: string,
  rows: Array<{ id: string; userId: string }>,
  update: (id: string, workspaceId: string) => Promise<unknown>,
): Promise<BackfillResult> {
  let updated = 0;
  let unresolved = 0;

  for (const row of rows) {
    const workspace = await prisma.workspace.findUnique({
      where: { slug: `personal-${row.userId}` },
      select: { id: true },
    });

    if (!workspace) {
      unresolved += 1;
      console.warn(
        `[${table}] no personal workspace found for userId=${row.userId} (row ${row.id}) — left workspaceId NULL. Run backfill-tenancy.ts for this user first.`,
      );
      continue;
    }

    await update(row.id, workspace.id);
    updated += 1;
  }

  return { table, updated, unresolved };
}

async function main(): Promise<void> {
  const results = await Promise.all([
    backfillApiKey(),
    backfillProviderCredential(),
    backfillUserModelAccess(),
  ]);

  for (const result of results) {
    console.log(`${result.table}: updated ${result.updated}, unresolved ${result.unresolved}.`);
  }

  const remainingNull = await Promise.all([
    prisma.apiKey.count({ where: { workspaceId: null } }),
    prisma.providerCredential.count({ where: { workspaceId: null } }),
    prisma.userModelAccess.count({ where: { workspaceId: null } }),
  ]);

  console.log(
    `Remaining NULL workspaceId — ApiKey: ${remainingNull[0]}, ProviderCredential: ${remainingNull[1]}, UserModelAccess: ${remainingNull[2]}.`,
  );

  if (remainingNull.some((count) => count > 0)) {
    console.warn(
      "Not all rows have a non-null workspaceId yet. Do NOT proceed to make workspaceId required or drop userId until this is zero.",
    );
  }
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
