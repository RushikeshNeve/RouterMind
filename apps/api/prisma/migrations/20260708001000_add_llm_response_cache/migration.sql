-- CreateTable
CREATE TABLE "LLMResponseCache" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "cacheKey" TEXT NOT NULL,
    "normalizedPromptHash" TEXT NOT NULL,
    "promptText" TEXT NOT NULL,
    "responseJson" JSONB NOT NULL,
    "model" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "costSavedUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "hitCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LLMResponseCache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LLMResponseCache_cacheKey_key" ON "LLMResponseCache"("cacheKey");

-- CreateIndex
CREATE INDEX "LLMResponseCache_userId_idx" ON "LLMResponseCache"("userId");

-- CreateIndex
CREATE INDEX "LLMResponseCache_normalizedPromptHash_idx" ON "LLMResponseCache"("normalizedPromptHash");

-- CreateIndex
CREATE INDEX "LLMResponseCache_expiresAt_idx" ON "LLMResponseCache"("expiresAt");
