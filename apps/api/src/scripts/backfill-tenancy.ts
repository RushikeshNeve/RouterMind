import { PrismaClient } from "@prisma/client";

import { loadConfig } from "../config.js";

loadConfig();
const prisma = new PrismaClient();

async function main(): Promise<void> {
  const users = await prisma.user.findMany({
    select: { id: true, name: true, email: true },
  });

  let created = 0;
  let alreadyBackfilled = 0;

  for (const user of users) {
    const slug = `personal-${user.id}`;

    const existingWorkspace = await prisma.workspace.findUnique({
      where: { slug },
    });

    if (existingWorkspace) {
      const existingOwnerMembership = await prisma.membership.findFirst({
        where: { workspaceId: existingWorkspace.id, role: "Owner" },
      });

      if (existingOwnerMembership) {
        alreadyBackfilled += 1;
        continue;
      }

      // Workspace/Organization exist from a prior partial run; finish linking them.
      const principal = await prisma.principal.create({
        data: { type: "user", displayName: user.name },
      });

      await prisma.membership.create({
        data: {
          workspaceId: existingWorkspace.id,
          principalId: principal.id,
          role: "Owner",
        },
      });

      created += 1;
      continue;
    }

    const organization = await prisma.organization.create({
      data: { name: `${user.name}'s Organization` },
    });

    const workspace = await prisma.workspace.create({
      data: {
        name: `${user.name}'s Workspace`,
        slug,
        organizationId: organization.id,
      },
    });

    const principal = await prisma.principal.create({
      data: { type: "user", displayName: user.name },
    });

    await prisma.membership.create({
      data: {
        workspaceId: workspace.id,
        principalId: principal.id,
        role: "Owner",
      },
    });

    created += 1;
  }

  console.log(
    `Tenancy backfill complete. Users processed: ${users.length}, created: ${created}, already backfilled: ${alreadyBackfilled}.`,
  );
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
