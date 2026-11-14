CREATE TABLE "face_rejections" (
	"face_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	CONSTRAINT "face_rejections_face_id_person_id_pk" PRIMARY KEY("face_id","person_id")
);
--> statement-breakpoint
CREATE TABLE "faces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"x" real NOT NULL,
	"y" real NOT NULL,
	"w" real NOT NULL,
	"h" real NOT NULL,
	"score" real DEFAULT 0 NOT NULL,
	"quality" real DEFAULT 0 NOT NULL,
	"vec" "bytea" NOT NULL,
	"model" text NOT NULL,
	"person_id" uuid,
	"status" text DEFAULT 'unsorted' NOT NULL,
	"suggested_id" uuid,
	"confidence" real,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "persons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"name" text NOT NULL,
	"cover_face_id" uuid,
	"strict" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spaces" ADD COLUMN "people" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "face_rejections" ADD CONSTRAINT "face_rejections_face_id_faces_id_fk" FOREIGN KEY ("face_id") REFERENCES "public"."faces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "face_rejections" ADD CONSTRAINT "face_rejections_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "faces" ADD CONSTRAINT "faces_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "faces" ADD CONSTRAINT "faces_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "faces" ADD CONSTRAINT "faces_suggested_id_persons_id_fk" FOREIGN KEY ("suggested_id") REFERENCES "public"."persons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "faces" ADD CONSTRAINT "faces_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persons" ADD CONSTRAINT "persons_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persons" ADD CONSTRAINT "persons_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "faces_item_idx" ON "faces" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "faces_person_idx" ON "faces" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "faces_status_idx" ON "faces" USING btree ("status");--> statement-breakpoint
CREATE INDEX "persons_space_idx" ON "persons" USING btree ("space_id");