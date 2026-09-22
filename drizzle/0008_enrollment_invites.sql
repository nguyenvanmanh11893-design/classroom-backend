CREATE TYPE "public"."enrollment_event_type" AS ENUM('enrolled', 'cancelled', 'reactivated');--> statement-breakpoint
CREATE TABLE "enrollment_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "student_id" text NOT NULL,
  "class_id" integer NOT NULL,
  "type" "enrollment_event_type" NOT NULL,
  "actor_id" text,
  "source" varchar(30) NOT NULL,
  "occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "class_invites" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "class_id" integer NOT NULL,
  "code_hash" varchar(64) NOT NULL,
  "expires_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "max_uses" integer,
  "used_count" integer DEFAULT 0 NOT NULL,
  "created_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "class_invites_code_hash_unique" UNIQUE("code_hash"),
  CONSTRAINT "class_invites_counts_valid" CHECK ("used_count" >= 0 AND ("max_uses" IS NULL OR "max_uses" > 0))
);--> statement-breakpoint
ALTER TABLE "enrollment_events" ADD CONSTRAINT "enrollment_events_student_id_user_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."user"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "enrollment_events" ADD CONSTRAINT "enrollment_events_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "enrollment_events" ADD CONSTRAINT "enrollment_events_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "class_invites" ADD CONSTRAINT "class_invites_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "class_invites" ADD CONSTRAINT "class_invites_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE restrict;--> statement-breakpoint
CREATE INDEX "enrollment_events_class_occurred_idx" ON "enrollment_events" USING btree ("class_id","occurred_at");--> statement-breakpoint
CREATE INDEX "class_invites_class_id_idx" ON "class_invites" USING btree ("class_id");
