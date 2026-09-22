import {
    integer,
    jsonb,
    pgEnum,
    pgTable,
    text,
    timestamp,
    unique,
    varchar,
    index,
    primaryKey
    ,uuid, boolean
} from "drizzle-orm/pg-core";
import {relations} from "drizzle-orm";
import {user} from "./auth.js";

export const classStatusEnum = pgEnum('class_status', ['active', 'inactive', 'archived']);
export const classLifecycleStatusEnum = pgEnum('class_lifecycle_status', ['draft', 'open', 'closed', 'completed', 'cancelled']);
export const enrollmentStatusEnum = pgEnum('enrollment_status', ['active', 'cancelled']);
export const enrollmentEventTypeEnum = pgEnum('enrollment_event_type', ['enrolled', 'cancelled', 'reactivated']);

const timestamps = {
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().$onUpdate(() => new Date()).notNull()
}

export const departments = pgTable('departments', {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    code: varchar('code', {length: 50}).notNull().unique(),
    name: varchar('name', {length: 255}).notNull(),
    description: varchar('description', {length: 255}),
    ...timestamps
});

export const subjects = pgTable('subjects', {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    departmentId: integer('department_id').notNull().references(() => departments.id, { onDelete: 'restrict' }),
    name: varchar('name', {length: 255}).notNull(),
    code: varchar('code', {length: 50}).notNull().unique(),
    description: varchar('description', {length: 255}),
    ...timestamps
});

export const semesterStatusEnum = pgEnum('semester_status', ['draft', 'active', 'archived']);
export const semesters = pgTable('semesters', {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    code: varchar('code', { length: 50 }).notNull().unique(),
    name: varchar('name', { length: 255 }).notNull(),
    startsOn: timestamp('starts_on', { withTimezone: false }).notNull(),
    endsOn: timestamp('ends_on', { withTimezone: false }).notNull(),
    registrationStartsOn: timestamp('registration_starts_on', { withTimezone: false }).notNull(),
    registrationEndsOn: timestamp('registration_ends_on', { withTimezone: false }).notNull(),
    status: semesterStatusEnum('status').default('draft').notNull(),
    ...timestamps,
});

export const classes = pgTable('classes', {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    // A subject with classes is a business constraint, never a cascading delete.
    subjectId: integer('subject_id').notNull().references(() => subjects.id, { onDelete: 'restrict' }),
    semesterId: integer('semester_id').references(() => semesters.id, { onDelete: 'restrict' }),
    teacherId: text('teacher_id').notNull().references(() => user.id, { onDelete: 'restrict' }),
    inviteCode: text('invite_code').notNull().unique(),
    name: varchar('name', {length: 255}).notNull(),
    bannerCldPubId: text('banner_cld_pub_id'),
    bannerUrl: text('banner_url'),
    description: text('description'),
    capacity: integer('capacity').default(50).notNull(),
    status: classStatusEnum('status').default('active').notNull(),
    lifecycleStatus: classLifecycleStatusEnum('lifecycle_status').default('draft').notNull(),
    legacyStatus: varchar('legacy_status', { length: 20 }),
    statusMigrationReviewRequired: integer('status_migration_review_required').default(0).notNull(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    archivedBy: text('archived_by').references(() => user.id, { onDelete: 'restrict' }),
    schedules: jsonb('schedules').$type<any[]>().default([]).notNull(),
    ...timestamps
}, (table) => [
    index('classes_subject_id_idx').on(table.subjectId),
    index('classes_teacher_id_idx').on(table.teacherId),
    index('classes_semester_id_idx').on(table.semesterId),
]);

export const classSchedules = pgTable('class_schedules', {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    classId: integer('class_id').notNull().references(() => classes.id, { onDelete: 'cascade' }),
    dayOfWeek: integer('day_of_week').notNull(),
    startTime: varchar('start_time', { length: 5 }).notNull(),
    endTime: varchar('end_time', { length: 5 }).notNull(),
}, (table) => [index('class_schedules_class_id_idx').on(table.classId)]);

export const enrollments = pgTable('enrollments', {
    studentId: text('student_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    classId: integer('class_id').notNull().references(() => classes.id, { onDelete: 'cascade' }),
    status: enrollmentStatusEnum('status').default('active').notNull(),
    enrolledAt: timestamp('enrolled_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    timeSource: varchar('time_source', { length: 30 }).default('legacy_unknown').notNull(),
}, (table) => [
    primaryKey({ columns: [table.studentId, table.classId] }),
    unique('enrollments_student_id_class_id_unique').on(table.studentId, table.classId),
    index('enrollments_student_id_idx').on(table.studentId),
    index('enrollments_class_id_idx').on(table.classId),
]);

export const enrollmentEvents = pgTable('enrollment_events', {
    id: uuid('id').defaultRandom().primaryKey(),
    studentId: text('student_id').notNull().references(() => user.id, { onDelete: 'restrict' }),
    classId: integer('class_id').notNull().references(() => classes.id, { onDelete: 'restrict' }),
    type: enrollmentEventTypeEnum('type').notNull(),
    actorId: text('actor_id').references(() => user.id, { onDelete: 'restrict' }),
    source: varchar('source', { length: 30 }).notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [index('enrollment_events_class_occurred_idx').on(table.classId, table.occurredAt)]);

export const classInvites = pgTable('class_invites', {
    id: uuid('id').defaultRandom().primaryKey(),
    classId: integer('class_id').notNull().references(() => classes.id, { onDelete: 'restrict' }),
    codeHash: varchar('code_hash', { length: 64 }).notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    maxUses: integer('max_uses'),
    usedCount: integer('used_count').default(0).notNull(),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [index('class_invites_class_id_idx').on(table.classId)]);

export const auditLogs = pgTable('audit_logs', {
    id: uuid('id').defaultRandom().primaryKey(),
    actorId: text('actor_id').references(() => user.id, { onDelete: 'restrict' }),
    entityType: varchar('entity_type', { length: 100 }).notNull(),
    entityId: text('entity_id').notNull(),
    action: varchar('action', { length: 100 }).notNull(),
    requestId: varchar('request_id', { length: 100 }).notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}).notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
    index('audit_logs_actor_id_idx').on(table.actorId),
    index('audit_logs_entity_idx').on(table.entityType, table.entityId),
    index('audit_logs_occurred_at_idx').on(table.occurredAt),
]);

export const departmentRelations = relations(departments, ({ many }) => ({ subjects: many(subjects) }));

export const subjectsRelations = relations(subjects, ({ one, many }) => ({
    department: one(departments, {
        fields: [subjects.departmentId],
        references: [departments.id],
    }),
    classes: many(classes)
}));

export const classesRelations = relations(classes, ({ one, many }) => ({
    subject: one(subjects, {
        fields: [classes.subjectId],
        references: [subjects.id],
    }),
    teacher: one(user, {
        fields: [classes.teacherId],
        references: [user.id],
    }),
    enrollments: many(enrollments)
}));

export const classSchedulesRelations = relations(classSchedules, ({ one }) => ({
    class: one(classes, { fields: [classSchedules.classId], references: [classes.id] }),
}));

export const enrollmentsRelations = relations(enrollments, ({ one }) => ({
    student: one(user, {
        fields: [enrollments.studentId],
        references: [user.id],
    }),
    class: one(classes, {
        fields: [enrollments.classId],
        references: [classes.id],
    }),
}));

export type Department = typeof departments.$inferSelect;
export type NewDepartment = typeof departments.$inferInsert;

export type Subject = typeof subjects.$inferSelect;
export type NewSubject = typeof subjects.$inferInsert;
export type Semester = typeof semesters.$inferSelect;
export type NewSemester = typeof semesters.$inferInsert;

export type Class = typeof classes.$inferSelect;
export type NewClass = typeof classes.$inferInsert;

export type Enrollment = typeof enrollments.$inferSelect;
export type NewEnrollment = typeof enrollments.$inferInsert;

export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;
