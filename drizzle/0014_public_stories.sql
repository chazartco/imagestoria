ALTER TABLE "stories" ADD COLUMN "public" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "featured" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "public_download" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "slug" text;--> statement-breakpoint
CREATE UNIQUE INDEX "stories_slug_uq" ON "stories" USING btree ("slug");