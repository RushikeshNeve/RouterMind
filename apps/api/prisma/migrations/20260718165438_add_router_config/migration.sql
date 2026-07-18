-- CreateTable
CREATE TABLE "RouterConfig" (
    "id" TEXT NOT NULL,
    "scopeType" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "fallbackModel" TEXT,
    "credentialId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RouterConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RouterConfig_scopeType_scopeId_idx" ON "RouterConfig"("scopeType", "scopeId");

-- CreateIndex
CREATE INDEX "RouterConfig_credentialId_idx" ON "RouterConfig"("credentialId");

-- CreateIndex
CREATE UNIQUE INDEX "RouterConfig_scopeType_scopeId_key" ON "RouterConfig"("scopeType", "scopeId");

-- AddForeignKey
ALTER TABLE "RouterConfig" ADD CONSTRAINT "RouterConfig_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "ProviderCredential"("id") ON DELETE SET NULL ON UPDATE CASCADE;
