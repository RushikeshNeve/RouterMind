-- CreateTable
CREATE TABLE "PolicyRule" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "pattern" TEXT,
    "action" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PolicyRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FirewallEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "requestLogId" TEXT,
    "ruleId" TEXT,
    "type" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "matchedText" TEXT,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FirewallEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PolicyRule_userId_idx" ON "PolicyRule"("userId");

-- CreateIndex
CREATE INDEX "PolicyRule_type_idx" ON "PolicyRule"("type");

-- CreateIndex
CREATE INDEX "PolicyRule_isActive_idx" ON "PolicyRule"("isActive");

-- CreateIndex
CREATE INDEX "FirewallEvent_userId_idx" ON "FirewallEvent"("userId");

-- CreateIndex
CREATE INDEX "FirewallEvent_requestLogId_idx" ON "FirewallEvent"("requestLogId");

-- CreateIndex
CREATE INDEX "FirewallEvent_ruleId_idx" ON "FirewallEvent"("ruleId");

-- CreateIndex
CREATE INDEX "FirewallEvent_type_idx" ON "FirewallEvent"("type");

-- CreateIndex
CREATE INDEX "FirewallEvent_action_idx" ON "FirewallEvent"("action");

-- CreateIndex
CREATE INDEX "FirewallEvent_severity_idx" ON "FirewallEvent"("severity");

-- CreateIndex
CREATE INDEX "FirewallEvent_createdAt_idx" ON "FirewallEvent"("createdAt");

-- AddForeignKey
ALTER TABLE "FirewallEvent" ADD CONSTRAINT "FirewallEvent_requestLogId_fkey" FOREIGN KEY ("requestLogId") REFERENCES "RequestLog"("id") ON DELETE SET NULL ON UPDATE CASCADE;
