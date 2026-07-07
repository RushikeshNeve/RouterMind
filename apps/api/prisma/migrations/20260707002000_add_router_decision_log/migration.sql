CREATE TABLE "RouterDecisionLog" (
    "id" TEXT NOT NULL,
    "requestLogId" TEXT,
    "userId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "routerModelUsed" TEXT,
    "detectedTask" TEXT,
    "complexity" TEXT,
    "candidateModelsJson" JSONB NOT NULL,
    "selectedModel" TEXT,
    "selectedProvider" TEXT,
    "confidence" DOUBLE PRECISION,
    "reason" TEXT,
    "fallbackUsed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RouterDecisionLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RouterDecisionLog_requestLogId_idx" ON "RouterDecisionLog"("requestLogId");
CREATE INDEX "RouterDecisionLog_userId_idx" ON "RouterDecisionLog"("userId");

ALTER TABLE "RouterDecisionLog" ADD CONSTRAINT "RouterDecisionLog_requestLogId_fkey" FOREIGN KEY ("requestLogId") REFERENCES "RequestLog"("id") ON DELETE SET NULL ON UPDATE CASCADE;
