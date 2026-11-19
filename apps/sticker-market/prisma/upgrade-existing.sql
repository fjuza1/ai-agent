-- Apply once to a backup-verified database using the original schema.
PRAGMA foreign_keys=ON;
BEGIN TRANSACTION;
ALTER TABLE "User" ADD COLUMN "stickerCredits" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Sticker" ADD COLUMN "imageId" TEXT;
ALTER TABLE "Purchase" ADD COLUMN "quotaDay" TEXT;
ALTER TABLE "Purchase" ADD COLUMN "quotaUnits" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Purchase" ADD COLUMN "creditUnits" INTEGER NOT NULL DEFAULT 0;
CREATE TABLE "StickerDailyUsage" (
  "userId" TEXT NOT NULL,
  "day" TEXT NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY ("userId", "day"),
  FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
COMMIT;
