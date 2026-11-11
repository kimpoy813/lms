-- Hosts without a lasting disk or a process that stays up (function platforms such as Vercel):
-- uploaded files can be kept in the database, and background jobs are claimed by requests.

-- CreateTable
CREATE TABLE "FileBlob" (
    "storedName" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FileBlob_pkey" PRIMARY KEY ("storedName")
);

-- Uploads are mostly compressed formats already (PDF, images, office documents). EXTERNAL skips
-- the pointless second compression and lets PostgreSQL read part of a file without loading all
-- of it, which the download route relies on.
ALTER TABLE "FileBlob" ALTER COLUMN "data" SET STORAGE EXTERNAL;

-- CreateTable
CREATE TABLE "JobState" (
    "name" TEXT NOT NULL,
    "everyMs" INTEGER NOT NULL,
    "lastRunAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "JobState_pkey" PRIMARY KEY ("name")
);
