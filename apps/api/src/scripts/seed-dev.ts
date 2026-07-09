import { randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";

import { loadConfig } from "../config.js";
import { hashApiKey } from "../security/api-key.js";
import { encryptCredential } from "../security/credentials.js";

const config = loadConfig();
const prisma = new PrismaClient();

const devModels = [
  { provider: "openai", model: "gpt-4o" },
  { provider: "openai", model: "gpt-4o-mini" },
  { provider: "anthropic", model: "claude-3-5-sonnet" },
  { provider: "gemini", model: "gemini-1.5-flash" },
  { provider: "groq", model: "llama-3.1-70b-versatile" },
] as const;

const mockProviderKeys = {
  openai: "mock-openai-key",
  anthropic: "mock-anthropic-key",
  gemini: "mock-gemini-key",
  groq: "mock-groq-key",
} as const;

try {
  const user = await prisma.user.upsert({
    where: { email: "dev@routemind.local" },
    create: {
      name: "RouteMind Dev User",
      email: "dev@routemind.local",
    },
    update: {
      name: "RouteMind Dev User",
    },
  });

  const apiKey = `rm_test_${randomBytes(32).toString("base64url")}`;

  await prisma.apiKey.create({
    data: {
      userId: user.id,
      name: "Local Dev Key",
      keyHash: hashApiKey(apiKey),
    },
  });

  await Promise.all(
    Object.entries(mockProviderKeys).map(([provider, apiKeyValue]) =>
      prisma.providerCredential.upsert({
        where: {
          userId_provider: {
            userId: user.id,
            provider,
          },
        },
        create: {
          userId: user.id,
          provider,
          encryptedApiKey: encryptCredential(apiKeyValue, config.CREDENTIAL_ENCRYPTION_KEY),
          isEnabled: true,
        },
        update: {
          encryptedApiKey: encryptCredential(apiKeyValue, config.CREDENTIAL_ENCRYPTION_KEY),
          isEnabled: true,
        },
      }),
    ),
  );

  await Promise.all(
    devModels.map((model) =>
      prisma.userModelAccess.upsert({
        where: {
          userId_provider_model: {
            userId: user.id,
            provider: model.provider,
            model: model.model,
          },
        },
        create: {
          userId: user.id,
          provider: model.provider,
          model: model.model,
          isEnabled: true,
        },
        update: {
          isEnabled: true,
        },
      }),
    ),
  );

  await seedEvaluationDatasets();

  console.log("RouteMind dev user seeded.");
  console.log(`User ID: ${user.id}`);
  console.log(`RouteMind API key: ${apiKey}`);
  console.log("Store this key now. It is hashed in the database and will not be shown again.");
} finally {
  await prisma.$disconnect();
}

async function seedEvaluationDatasets(): Promise<void> {
  const datasets = [
    {
      name: "Summarization",
      description: "Checks concise summaries preserve important facts.",
      taskType: "summarization",
      cases: [
        ["Summarize: API latency rose after deploy.", "latency rose", "contains"],
        ["Summarize: Budget guardrails blocked five requests.", "budget guardrails", "contains"],
        ["Summarize: Provider fallback recovered the request.", "fallback recovered", "contains"],
      ],
    },
    {
      name: "Code debugging",
      description: "Checks debugging answers identify concrete failures.",
      taskType: "debugging",
      cases: [
        ["Bug: undefined is not a function in handler.", "undefined", "contains"],
        ["Stack trace points to retry policy timeout.", "timeout", "contains"],
        ["TypeScript says property provider is missing.", "provider", "contains"],
      ],
    },
    {
      name: "JSON extraction",
      description: "Checks exact structured extraction.",
      taskType: "extraction",
      cases: [
        ['Extract status from "status: ok"', "ok", "exact_match"],
        ['Extract provider from "provider=openai"', "openai", "exact_match"],
        ['Extract model from "model=gpt-4o"', "gpt-4o", "exact_match"],
      ],
    },
    {
      name: "Simple chat",
      description: "Checks short helpful responses.",
      taskType: "simple_chat",
      cases: [
        ["Say hello", "hello", "contains"],
        ["Reply with ok", "ok", "contains"],
        ["Confirm readiness", "ready", "contains"],
      ],
    },
  ] as const;

  for (const dataset of datasets) {
    const datasetId = randomUUID();
    await prisma.$executeRaw`
      INSERT INTO "EvaluationDataset" ("id", "name", "description", "taskType", "createdAt", "updatedAt")
      VALUES (${datasetId}, ${dataset.name}, ${dataset.description}, ${dataset.taskType}, ${new Date()}, ${new Date()})
    `;

    for (const [prompt, expectedOutput, gradingRubric] of dataset.cases) {
      await prisma.$executeRaw`
        INSERT INTO "EvaluationCase" (
          "id",
          "datasetId",
          "inputMessagesJson",
          "expectedOutput",
          "gradingRubric",
          "metadataJson",
          "createdAt",
          "updatedAt"
        )
        VALUES (
          ${randomUUID()},
          ${datasetId},
          ${JSON.stringify([{ role: "user", content: prompt }])}::jsonb,
          ${expectedOutput},
          ${gradingRubric},
          ${JSON.stringify({ seeded: true })}::jsonb,
          ${new Date()},
          ${new Date()}
        )
      `;
    }
  }
}
