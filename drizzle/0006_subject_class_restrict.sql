-- Prevent a subject DELETE from cascading to classes created after the
-- application-level usage check. PostgreSQL enforces this atomically.
ALTER TABLE "classes" DROP CONSTRAINT IF EXISTS "classes_subject_id_subjects_id_fk";
--> statement-breakpoint
ALTER TABLE "classes" ADD CONSTRAINT "classes_subject_id_subjects_id_fk"
  FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;
