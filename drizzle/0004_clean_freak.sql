ALTER TABLE "enrollments" DROP CONSTRAINT "enrollments_student_id_class_id_unique";--> statement-breakpoint
ALTER TABLE "session" DROP CONSTRAINT "session_token_unique";--> statement-breakpoint
ALTER TABLE "user" DROP CONSTRAINT "user_email_unique";--> statement-breakpoint
ALTER TABLE "account" DROP CONSTRAINT "account_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "session" DROP CONSTRAINT "session_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "enrollments" DROP CONSTRAINT "enrollments_student_id_class_id_pk";--> statement-breakpoint
ALTER TABLE "classes" ALTER COLUMN "invite_code" SET DATA TYPE varchar(50);--> statement-breakpoint
ALTER TABLE "classes" ALTER COLUMN "schedules" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "departments" ALTER COLUMN "description" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "subjects" ALTER COLUMN "description" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "enrollments" ADD COLUMN "id" integer PRIMARY KEY NOT NULL GENERATED ALWAYS AS IDENTITY (sequence name "enrollments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1);--> statement-breakpoint
ALTER TABLE "enrollments" ADD COLUMN "created_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "enrollments" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "enrollments_student_class_unique" ON "enrollments" USING btree ("student_id","class_id");--> statement-breakpoint
CREATE UNIQUE INDEX "account_provider_account_unique" ON "account" USING btree ("provider_id","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_token_unique" ON "session" USING btree ("token");--> statement-breakpoint
ALTER TABLE "account" DROP COLUMN "issuer";