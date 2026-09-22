CREATE TYPE "public"."class_lifecycle_status" AS ENUM('draft', 'open', 'closed', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."enrollment_status" AS ENUM('active', 'cancelled');--> statement-breakpoint
ALTER TABLE "classes" ADD COLUMN "semester_id" integer;--> statement-breakpoint
ALTER TABLE "classes" ADD COLUMN "lifecycle_status" "class_lifecycle_status" DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "classes" ADD COLUMN "legacy_status" varchar(20);--> statement-breakpoint
ALTER TABLE "classes" ADD COLUMN "status_migration_review_required" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "classes" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "classes" ADD COLUMN "archived_by" text;--> statement-breakpoint
ALTER TABLE "classes" ADD CONSTRAINT "classes_semester_id_semesters_id_fk" FOREIGN KEY ("semester_id") REFERENCES "public"."semesters"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "classes" ADD CONSTRAINT "classes_archived_by_user_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."user"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "classes" ADD CONSTRAINT "classes_capacity_positive" CHECK ("capacity" > 0);--> statement-breakpoint
UPDATE "classes" SET "legacy_status" = "status"::text, "lifecycle_status" = (CASE "status"::text WHEN 'active' THEN 'open' ELSE 'closed' END)::"class_lifecycle_status", "status_migration_review_required" = CASE WHEN "status"::text = 'active' THEN 0 ELSE 1 END, "archived_at" = CASE WHEN "status"::text = 'archived' THEN now() ELSE NULL END;--> statement-breakpoint
CREATE TABLE "class_schedules" ("id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY, "class_id" integer NOT NULL, "day_of_week" integer NOT NULL, "start_time" varchar(5) NOT NULL, "end_time" varchar(5) NOT NULL, CONSTRAINT "class_schedules_day_valid" CHECK ("day_of_week" BETWEEN 1 AND 7), CONSTRAINT "class_schedules_time_valid" CHECK ("start_time" < "end_time"));--> statement-breakpoint
ALTER TABLE "class_schedules" ADD CONSTRAINT "class_schedules_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE cascade;--> statement-breakpoint
CREATE INDEX "class_schedules_class_id_idx" ON "class_schedules" USING btree ("class_id");--> statement-breakpoint
ALTER TABLE "enrollments" ADD COLUMN "status" "enrollment_status" DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "enrollments" ADD COLUMN "enrolled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "enrollments" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "enrollments" ADD COLUMN "time_source" varchar(30) DEFAULT 'legacy_unknown' NOT NULL;--> statement-breakpoint
-- Existing JSON is deliberately retained. Only recognized rows are copied; invalid values remain in classes.schedules for review.
INSERT INTO "class_schedules" ("class_id", "day_of_week", "start_time", "end_time")
SELECT c.id, (item->>'dayOfWeek')::integer, item->>'startTime', item->>'endTime'
FROM "classes" c CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.schedules) = 'array' THEN c.schedules ELSE '[]'::jsonb END) item
WHERE jsonb_typeof(c.schedules) = 'array' AND item ?& array['dayOfWeek','startTime','endTime']
  AND (item->>'dayOfWeek') ~ '^[1-7]$' AND (item->>'startTime') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND (item->>'endTime') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND (item->>'startTime') < (item->>'endTime');
