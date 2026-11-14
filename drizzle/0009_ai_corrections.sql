ALTER TABLE "item_labels" ADD COLUMN "source" text DEFAULT 'ai' NOT NULL;--> statement-breakpoint
ALTER TABLE "item_labels" ADD COLUMN "removed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "ai_locked" text[] DEFAULT '{}'::text[] NOT NULL;