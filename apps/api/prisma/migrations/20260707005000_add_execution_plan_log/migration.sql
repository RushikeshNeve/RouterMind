CREATE TABLE "ExecutionPlanLog" (
  "id" TEXT NOT NULL,
  "requestLogId" TEXT,
  "userId" TEXT NOT NULL,
  "planType" TEXT NOT NULL,
  "stepsJson" JSONB NOT NULL,
  "estimatedCostUsd" DOUBLE PRECISION NOT NULL,
  "actualCostUsd" DOUBLE PRECISION,
  "confidence" DOUBLE PRECISION NOT NULL,
  "reason" TEXT NOT NULL,
  "executed" BOOLEAN NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ExecutionPlanLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ExecutionPlanLog_requestLogId_idx" ON "ExecutionPlanLog"("requestLogId");
CREATE INDEX "ExecutionPlanLog_userId_idx" ON "ExecutionPlanLog"("userId");
CREATE INDEX "ExecutionPlanLog_planType_idx" ON "ExecutionPlanLog"("planType");
CREATE INDEX "ExecutionPlanLog_createdAt_idx" ON "ExecutionPlanLog"("createdAt");

ALTER TABLE "ExecutionPlanLog"
  ADD CONSTRAINT "ExecutionPlanLog_requestLogId_fkey"
  FOREIGN KEY ("requestLogId") REFERENCES "RequestLog"("id") ON DELETE SET NULL ON UPDATE CASCADE;
