CREATE TABLE "GatewayMetadata" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GatewayMetadata_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GatewayMetadata_key_key" ON "GatewayMetadata"("key");

CREATE TABLE "RequestLog" (
    "id" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "requestedModel" TEXT NOT NULL,
    "selectedModel" TEXT,
    "provider" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "estimatedCost" DOUBLE PRECISION,
    "latencyMs" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RequestLog_pkey" PRIMARY KEY ("id")
);
