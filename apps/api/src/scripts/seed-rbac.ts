import { PrismaClient } from "@prisma/client";

import { loadConfig } from "../config.js";

loadConfig();
const prisma = new PrismaClient();

const ROLE_PERMISSIONS: Record<string, readonly string[]> = {
  Viewer: ["analytics.read"],
  Developer: ["analytics.read", "models.use"],
  Admin: [
    "analytics.read",
    "models.use",
    "models.manage",
    "provider.manage",
    "apikey.create",
    "apikey.delete",
  ],
  Owner: [
    "analytics.read",
    "models.use",
    "models.manage",
    "provider.manage",
    "apikey.create",
    "apikey.delete",
    "budget.manage",
    "workspace.manage",
  ],
};

async function main(): Promise<void> {
  for (const [roleName, permissions] of Object.entries(ROLE_PERMISSIONS)) {
    const role = await prisma.role.upsert({
      where: { name: roleName },
      create: { name: roleName },
      update: {},
    });

    for (const permission of permissions) {
      await prisma.rolePermission.upsert({
        where: { roleId_permission: { roleId: role.id, permission } },
        create: { roleId: role.id, permission },
        update: {},
      });
    }

    console.log(`Seeded role "${roleName}" with ${permissions.length} permission(s).`);
  }
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
