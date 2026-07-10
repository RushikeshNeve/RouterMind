import { PrismaClient } from "@prisma/client";

import { loadConfig } from "../config.js";

loadConfig();
const prisma = new PrismaClient();

async function main(): Promise<void> {
  const memberships = await prisma.membership.findMany({
    where: { roleId: null },
    select: { id: true, role: true },
  });

  let updated = 0;
  let unresolved = 0;

  for (const membership of memberships) {
    const role = await prisma.role.findUnique({
      where: { name: membership.role },
      select: { id: true },
    });

    if (!role) {
      unresolved += 1;
      console.warn(
        `[Membership] no seeded Role matches role string "${membership.role}" for membership ${membership.id} — left roleId NULL. Run seed-rbac.ts first.`,
      );
      continue;
    }

    await prisma.membership.update({
      where: { id: membership.id },
      data: { roleId: role.id },
    });
    updated += 1;
  }

  console.log(`Membership.roleId: updated ${updated}, unresolved ${unresolved}.`);

  const remainingNull = await prisma.membership.count({ where: { roleId: null } });
  console.log(`Remaining NULL roleId: ${remainingNull}.`);
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
