-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceMember" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceMember_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "ApiKey" ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "ProviderCredential" ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "UserModelAccess" ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "UserBudget" ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "UsageQuota" ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "RequestLog" ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "RouterDecisionLog" ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "ProviderAttemptLog" ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "ExecutionPlanLog" ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "FirewallEvent" ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "LLMResponseCache" ADD COLUMN "workspaceId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_slug_key" ON "Workspace"("slug");
CREATE UNIQUE INDEX "WorkspaceMember_workspaceId_userId_key" ON "WorkspaceMember"("workspaceId", "userId");
CREATE INDEX "WorkspaceMember_workspaceId_idx" ON "WorkspaceMember"("workspaceId");
CREATE INDEX "WorkspaceMember_userId_idx" ON "WorkspaceMember"("userId");
CREATE INDEX "WorkspaceMember_role_idx" ON "WorkspaceMember"("role");
CREATE INDEX "ApiKey_workspaceId_idx" ON "ApiKey"("workspaceId");
CREATE INDEX "ProviderCredential_workspaceId_idx" ON "ProviderCredential"("workspaceId");
CREATE INDEX "UserModelAccess_workspaceId_idx" ON "UserModelAccess"("workspaceId");
CREATE INDEX "UserBudget_workspaceId_idx" ON "UserBudget"("workspaceId");
CREATE INDEX "UsageQuota_workspaceId_idx" ON "UsageQuota"("workspaceId");
CREATE INDEX "RequestLog_workspaceId_idx" ON "RequestLog"("workspaceId");
CREATE INDEX "RouterDecisionLog_workspaceId_idx" ON "RouterDecisionLog"("workspaceId");
CREATE INDEX "ProviderAttemptLog_workspaceId_idx" ON "ProviderAttemptLog"("workspaceId");
CREATE INDEX "ExecutionPlanLog_workspaceId_idx" ON "ExecutionPlanLog"("workspaceId");
CREATE INDEX "FirewallEvent_workspaceId_idx" ON "FirewallEvent"("workspaceId");
CREATE INDEX "LLMResponseCache_workspaceId_idx" ON "LLMResponseCache"("workspaceId");

-- AddForeignKey
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
