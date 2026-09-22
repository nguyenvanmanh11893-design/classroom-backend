CREATE TYPE "public"."semester_status" AS ENUM('draft', 'active', 'archived');--> statement-breakpoint
CREATE TABLE "semesters" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "semesters_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"code" varchar(50) NOT NULL,
	"name" varchar(255) NOT NULL,
	"starts_on" timestamp NOT NULL,
	"ends_on" timestamp NOT NULL,
	"registration_starts_on" timestamp NOT NULL,
	"registration_ends_on" timestamp NOT NULL,
	"status" "semester_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "semesters_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "semesters" ADD CONSTRAINT "semesters_dates_valid" CHECK ("starts_on" <= "ends_on");
--> statement-breakpoint
ALTER TABLE "semesters" ADD CONSTRAINT "semesters_registration_dates_valid" CHECK ("registration_starts_on" <= "registration_ends_on" AND "registration_starts_on" >= "starts_on" AND "registration_ends_on" <= "ends_on");
