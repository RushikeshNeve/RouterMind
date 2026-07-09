CREATE TABLE "CircuitBreakerState" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'CLOSED',
  "failureCount" INTEGER NOT NULL DEFAULT 0,
  "openedAt" TIMESTAMP(3),
  "halfOpenAt" TIMESTAMP(3),
  "lastFailureAt" TIMESTAMP(3),
  "lastSuccessAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CircuitBreakerState_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProviderAttemptLog" (
  "id" TEXT NOT NULL,
  "requestLogId" TEXT,
  "userId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "attemptNumber" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "latencyMs" INTEGER NOT NULL,
  "errorType" TEXT,
  "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ProviderAttemptLog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CircuitBreakerState_provider_model_key" ON "CircuitBreakerState"("provider", "model");
CREATE INDEX "CircuitBreakerState_provider_idx" ON "CircuitBreakerState"("provider");
CREATE INDEX "CircuitBreakerState_model_idx" ON "CircuitBreakerState"("model");
CREATE INDEX "ProviderAttemptLog_requestLogId_idx" ON "ProviderAttemptLog"("requestLogId");
CREATE INDEX "ProviderAttemptLog_userId_idx" ON "ProviderAttemptLog"("userId");
CREATE INDEX "ProviderAttemptLog_provider_idx" ON "ProviderAttemptLog"("provider");
CREATE INDEX "ProviderAttemptLog_model_idx" ON "ProviderAttemptLog"("model");
CREATE INDEX "ProviderAttemptLog_createdAt_idx" ON "ProviderAttemptLog"("createdAt");

ALTER TABLE "ProviderAttemptLog"
  ADD CONSTRAINT "ProviderAttemptLog_requestLogId_fkey"
  FOREIGN KEY ("requestLogId") REFERENCES "RequestLog"("id") ON DELETE SET NULL ON UPDATE CASCADE;
