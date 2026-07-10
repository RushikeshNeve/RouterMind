-- AlterTable
ALTER TABLE "ApiKey" ADD COLUMN     "principalId" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "principalId" TEXT;

-- CreateTable
CREATE TABLE "ServiceAccount" (
    "id" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ServiceAccount_principalId_key" ON "ServiceAccount"("principalId");

-- CreateIndex
CREATE INDEX "ServiceAccount_createdByUserId_idx" ON "ServiceAccount"("createdByUserId");

-- CreateIndex
CREATE INDEX "ApiKey_principalId_idx" ON "ApiKey"("principalId");

-- CreateIndex
CREATE UNIQUE INDEX "User_principalId_key" ON "User"("principalId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_principalId_fkey" FOREIGN KEY ("principalId") REFERENCES "Principal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceAccount" ADD CONSTRAINT "ServiceAccount_principalId_fkey" FOREIGN KEY ("principalId") REFERENCES "Principal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceAccount" ADD CONSTRAINT "ServiceAccount_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_principalId_fkey" FOREIGN KEY ("principalId") REFERENCES "Principal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
