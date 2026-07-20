-- CreateTable
CREATE TABLE "Policy" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "ruleType" TEXT NOT NULL,
    "ruleJson" JSONB NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Policy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Policy_workspaceId_idx" ON "Policy"("workspaceId");

-- CreateIndex
CREATE INDEX "Policy_subjectType_subjectId_idx" ON "Policy"("subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "Policy_ruleType_idx" ON "Policy"("ruleType");

-- AddForeignKey
ALTER TABLE "Policy" ADD CONSTRAINT "Policy_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
