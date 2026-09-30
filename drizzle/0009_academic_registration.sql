ALTER TABLE semesters ALTER COLUMN registration_starts_on DROP NOT NULL;
ALTER TABLE semesters ALTER COLUMN registration_ends_on DROP NOT NULL;
ALTER TABLE classes ADD COLUMN starts_on date, ADD COLUMN ends_on date, ADD COLUMN schedule_review_required boolean NOT NULL DEFAULT true;
ALTER TABLE classes ADD CONSTRAINT classes_date_range CHECK ((starts_on IS NULL AND ends_on IS NULL) OR (starts_on IS NOT NULL AND ends_on IS NOT NULL AND starts_on <= ends_on));
--> statement-breakpoint
CREATE TABLE student_profiles (
 user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE RESTRICT,
 student_code varchar(50) NOT NULL UNIQUE, department_id integer NOT NULL REFERENCES departments(id) ON DELETE RESTRICT,
 major varchar(200), admission_year integer NOT NULL CHECK (admission_year BETWEEN 1900 AND 2200), date_of_birth date, phone varchar(30),
 academic_status varchar(30) NOT NULL DEFAULT 'studying' CHECK (academic_status IN ('studying','suspended','graduated','withdrawn')),
 created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now()
);
CREATE TABLE teacher_profiles (
 user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE RESTRICT,
 teacher_code varchar(50) NOT NULL UNIQUE, department_id integer NOT NULL REFERENCES departments(id) ON DELETE RESTRICT,
 academic_degree varchar(100), specialization varchar(200), phone varchar(30),
 employment_status varchar(30) NOT NULL DEFAULT 'active' CHECK (employment_status IN ('active','on_leave','inactive')),
 created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE time_slots (
 id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY, name varchar(100) NOT NULL UNIQUE,
 start_time varchar(5) NOT NULL, end_time varchar(5) NOT NULL, is_active boolean NOT NULL DEFAULT true,
 created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now(),
 CONSTRAINT time_slots_valid CHECK (start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND end_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND start_time < end_time)
);
ALTER TABLE class_schedules ADD COLUMN time_slot_id integer REFERENCES time_slots(id) ON DELETE RESTRICT;
INSERT INTO time_slots(name,start_time,end_time) SELECT DISTINCT 'Legacy ' || start_time || '-' || end_time,start_time,end_time FROM class_schedules;
UPDATE class_schedules s SET time_slot_id=t.id FROM time_slots t WHERE s.start_time=t.start_time AND s.end_time=t.end_time;
CREATE TABLE class_sessions (
 id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY, class_id integer NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
 session_date date NOT NULL, time_slot_id integer NOT NULL REFERENCES time_slots(id) ON DELETE RESTRICT,
 start_time varchar(5) NOT NULL, end_time varchar(5) NOT NULL,
 status varchar(20) NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','cancelled')),
 source varchar(20) NOT NULL DEFAULT 'recurring' CHECK (source IN ('recurring','manual')),
 note text, created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now(),
 CONSTRAINT class_sessions_time_valid CHECK (start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND end_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND start_time < end_time)
);
CREATE INDEX class_sessions_class_date_idx ON class_sessions(class_id,session_date);
--> statement-breakpoint
CREATE TABLE registration_periods (
 id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY, semester_id integer NOT NULL REFERENCES semesters(id) ON DELETE RESTRICT,
 name varchar(200) NOT NULL, opens_at timestamptz NOT NULL, closes_at timestamptz NOT NULL, cancellation_deadline timestamptz NOT NULL,
 status varchar(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','open','closed')),
 created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now(),
 CONSTRAINT registration_period_dates CHECK (opens_at < closes_at AND cancellation_deadline >= closes_at)
);
CREATE TABLE registration_period_classes (
 period_id integer NOT NULL REFERENCES registration_periods(id) ON DELETE CASCADE,
 class_id integer NOT NULL REFERENCES classes(id) ON DELETE CASCADE, PRIMARY KEY(period_id,class_id)
);
ALTER TABLE enrollments ADD COLUMN registration_period_id integer REFERENCES registration_periods(id) ON DELETE RESTRICT;
ALTER TABLE enrollment_events ADD COLUMN registration_period_id integer REFERENCES registration_periods(id) ON DELETE RESTRICT;
--> statement-breakpoint
-- Preserve old registration windows for admin review, without inventing class dates or student history.
INSERT INTO registration_periods(semester_id,name,opens_at,closes_at,cancellation_deadline,status)
 SELECT id,'Legacy registration - review required',registration_starts_on AT TIME ZONE 'Asia/Bangkok',
 (registration_ends_on::date + interval '1 day') AT TIME ZONE 'Asia/Bangkok',
 (registration_ends_on::date + interval '1 day') AT TIME ZONE 'Asia/Bangkok','draft'
 FROM semesters WHERE registration_starts_on IS NOT NULL AND registration_ends_on IS NOT NULL AND registration_starts_on <= registration_ends_on;
INSERT INTO registration_period_classes(period_id,class_id)
 SELECT p.id,c.id FROM registration_periods p JOIN classes c ON c.semester_id=p.semester_id;
