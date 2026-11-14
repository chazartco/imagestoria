ALTER TABLE "items" ADD COLUMN "location_source" text;--> statement-breakpoint
-- Every location that existed before this column was read from the file itself.
UPDATE "items" SET "location_source" = 'exif' WHERE "lat" IS NOT NULL AND "lng" IS NOT NULL;
