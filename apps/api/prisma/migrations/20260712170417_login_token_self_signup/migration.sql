-- AlterTable
ALTER TABLE "LoginToken" ADD COLUMN     "email" TEXT,
ALTER COLUMN "userId" DROP NOT NULL;
