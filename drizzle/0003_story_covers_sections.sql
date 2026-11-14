CREATE TABLE "story_sections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"story_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"text" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "cover_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "story_items" ADD COLUMN "section_id" uuid;--> statement-breakpoint
ALTER TABLE "story_items" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "story_sections" ADD CONSTRAINT "story_sections_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "story_sections_story_idx" ON "story_sections" USING btree ("story_id","position");--> statement-breakpoint
ALTER TABLE "story_items" ADD CONSTRAINT "story_items_section_id_story_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."story_sections"("id") ON DELETE set null ON UPDATE no action;