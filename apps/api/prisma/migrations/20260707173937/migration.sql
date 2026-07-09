-- CreateTable
CREATE TABLE "UserBudget" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "maxSpendUsd" DOUBLE PRECISION NOT NULL,
    "currentSpendUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "resetAt" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserBudget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageQuota" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "maxRequests" INTEGER NOT NULL,
    "currentRequests" INTEGER NOT NULL DEFAULT 0,
    "maxTokens" INTEGER NOT NULL,
    "currentTokens" INTEGER NOT NULL DEFAULT 0,
    "resetAt" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UsageQuota_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserBudget_userId_idx" ON "UserBudget"("userId");

-- CreateIndex
CREATE INDEX "UsageQuota_userId_idx" ON "UsageQuota"("userId");

-- AddForeignKey
ALTER TABLE "UserBudget" ADD CONSTRAINT "UserBudget_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageQuota" ADD CONSTRAINT "UsageQuota_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
