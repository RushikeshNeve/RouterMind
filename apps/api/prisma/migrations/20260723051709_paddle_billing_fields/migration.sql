/*
  Warnings:

  - You are about to drop the column `stripeSubscriptionId` on the `Subscription` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Plan" ADD COLUMN     "paddlePriceId" TEXT;

-- AlterTable
ALTER TABLE "Subscription" DROP COLUMN "stripeSubscriptionId",
ADD COLUMN     "paddleCustomerId" TEXT,
ADD COLUMN     "paddleSubscriptionId" TEXT;

-- CreateIndex
CREATE INDEX "Subscription_paddleSubscriptionId_idx" ON "Subscription"("paddleSubscriptionId");
