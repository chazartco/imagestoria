CREATE TABLE "place_names" (
	"id" integer PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"country" text DEFAULT '' NOT NULL,
	"alt" text
);
--> statement-breakpoint
CREATE TABLE "place_suggestions" (
	"item_id" uuid NOT NULL,
	"source" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"lat" double precision,
	"lng" double precision,
	"confidence" real DEFAULT 0 NOT NULL,
	"why" text DEFAULT '' NOT NULL,
	"from_item" uuid,
	"model" text,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "place_suggestions_item_id_source_pk" PRIMARY KEY("item_id","source")
);
--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "spot" text;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "spot_kind" text;--> statement-breakpoint
ALTER TABLE "place_suggestions" ADD CONSTRAINT "place_suggestions_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "place_names_at_idx" ON "place_names" USING btree ("lat","lng");--> statement-breakpoint
CREATE INDEX "place_names_name_idx" ON "place_names" USING btree (lower("name"));