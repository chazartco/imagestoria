CREATE TABLE "item_embeddings" (
	"item_id" uuid PRIMARY KEY NOT NULL,
	"model" text NOT NULL,
	"dim" integer NOT NULL,
	"vec" "bytea" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "item_embeddings" ADD CONSTRAINT "item_embeddings_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "item_embeddings_updated_idx" ON "item_embeddings" USING btree ("updated_at");