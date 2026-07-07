ALTER TABLE "RequestLog"
ADD COLUMN "providerStatusAtRouting" TEXT,
ADD COLUMN "providerAvgLatencyAtRouting" INTEGER,
ADD COLUMN "providerSuccessRateAtRouting" DOUBLE PRECISION,
ADD COLUMN "routingMode" TEXT,
ADD COLUMN "routingStrategy" TEXT;

CREATE TABLE "ProviderHealthMetric" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "avgLatencyMs" INTEGER NOT NULL,
    "p95LatencyMs" INTEGER NOT NULL,
    "successRate" DOUBLE PRECISION NOT NULL,
    "errorRate" DOUBLE PRECISION NOT NULL,
    "timeoutRate" DOUBLE PRECISION NOT NULL,
    "rateLimitRate" DOUBLE PRECISION NOT NULL,
    "windowMinutes" INTEGER NOT NULL,
    "sampleSize" INTEGER NOT NULL,
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "lastCheckedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderHealthMetric_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProviderHealthMetric_provider_model_key" ON "ProviderHealthMetric"("provider", "model");
CREATE INDEX "ProviderHealthMetric_provider_idx" ON "ProviderHealthMetric"("provider");
CREATE INDEX "ProviderHealthMetric_model_idx" ON "ProviderHealthMetric"("model");
