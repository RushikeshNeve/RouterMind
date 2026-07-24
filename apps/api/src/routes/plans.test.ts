import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import { testConfig } from "./workspaces-rbac-fixtures.js";

describe("GET /v1/plans", () => {
  const prisma = new PrismaClient({ datasourceUrl: testConfig.DATABASE_URL });
  const planIds: string[] = [];

  afterEach(async () => {
    await prisma.plan.deleteMany({ where: { id: { in: planIds.splice(0) } } });
  });

  it("returns plans publicly, with no auth required, ordered by price ascending", async () => {
    const cheap = await prisma.plan.create({
      data: {
        name: `Plans Test Cheap ${randomUUID()}`,
        priceCents: 100,
        includedRequests: 50,
        featuresJson: { foo: true },
        paddlePriceId: "pri_cheap",
      },
    });
    const expensive = await prisma.plan.create({
      data: {
        name: `Plans Test Expensive ${randomUUID()}`,
        priceCents: 900,
        includedRequests: null,
        featuresJson: {},
      },
    });
    planIds.push(cheap.id, expensive.id);

    const app = await buildApp({ config: testConfig, prisma });
    const response = await app.inject({ method: "GET", url: "/v1/plans" });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload) as {
      plans: Array<{
        id: string;
        name: string;
        selfServe: boolean;
        includedRequests: number | null;
      }>;
    };
    const names = body.plans.map((plan) => plan.name);
    expect(names.indexOf(cheap.name)).toBeLessThan(names.indexOf(expensive.name));
    const cheapEntry = body.plans.find((plan) => plan.id === cheap.id);
    const expensiveEntry = body.plans.find((plan) => plan.id === expensive.id);
    expect(cheapEntry?.selfServe).toBe(true);
    expect(expensiveEntry?.selfServe).toBe(false);
    expect(expensiveEntry?.includedRequests).toBeNull();

    await app.close();
  });
});
