ALTER TABLE "items" ADD COLUMN "play_key" text;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "bytes_play" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "play_status" text;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "play_error" text;