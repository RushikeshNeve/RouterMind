import type { PrismaClient } from "@prisma/client";

export const ROLE_PERMISSIONS: Record<string, readonly string[]> = {
  Viewer: ["analytics.read"],
  Developer: ["analytics.read", "models.use"],
  Admin: [
    "analytics.read",
    "models.use",
    "models.manage",
    "provider.manage",
    "apikey.read",
    "apikey.create",
    "apikey.delete",
    "audit.read",
  ],
  Owner: [
    "analytics.read",
    "models.use",
    "models.manage",
    "provider.manage",
    "apikey.read",
    "apikey.create",
    "apikey.delete",
    "budget.manage",
    "workspace.manage",
    "audit.read",
  ],
};

export async function seedRoles(prisma: PrismaClient): Promise<void> {
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

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/seed-rbac.ts")) {
  const { PrismaClient } = await import("@prisma/client");
  const { loadConfig } = await import("../config.js");
  loadConfig();
  const prisma = new PrismaClient();
  try {
    await seedRoles(prisma);
  } finally {
    await prisma.$disconnect();
  }
}
