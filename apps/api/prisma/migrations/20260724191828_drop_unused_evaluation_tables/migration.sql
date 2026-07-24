/*
  Warnings:

  - You are about to drop the `EvaluationCase` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `EvaluationDataset` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `EvaluationResult` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `EvaluationRun` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "EvaluationCase" DROP CONSTRAINT "EvaluationCase_datasetId_fkey";

-- DropForeignKey
ALTER TABLE "EvaluationResult" DROP CONSTRAINT "EvaluationResult_caseId_fkey";

-- DropForeignKey
ALTER TABLE "EvaluationResult" DROP CONSTRAINT "EvaluationResult_runId_fkey";

-- DropForeignKey
ALTER TABLE "EvaluationRun" DROP CONSTRAINT "EvaluationRun_datasetId_fkey";

-- DropTable
DROP TABLE "EvaluationCase";

-- DropTable
DROP TABLE "EvaluationDataset";

-- DropTable
DROP TABLE "EvaluationResult";

-- DropTable
DROP TABLE "EvaluationRun";
