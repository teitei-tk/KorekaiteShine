-- void:allow-destructive
-- 全列を新テーブルへコピーしてから置換する。外部キーの削除動作はNO ACTION。
PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_job_attempts` (
	`job_id` text NOT NULL,
	`attempt_number` integer NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`error_code` text,
	`result_json` text,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`job_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "job_attempts_number_range" CHECK(typeof("__new_job_attempts"."attempt_number") = 'integer' AND "__new_job_attempts"."attempt_number" BETWEEN 1 AND 4)
);
--> statement-breakpoint
INSERT INTO `__new_job_attempts`("job_id", "attempt_number", "started_at", "finished_at", "error_code", "result_json") SELECT "job_id", "attempt_number", "started_at", "finished_at", "error_code", "result_json" FROM `job_attempts`;--> statement-breakpoint
DROP TABLE `job_attempts`;--> statement-breakpoint
ALTER TABLE `__new_job_attempts` RENAME TO `job_attempts`;--> statement-breakpoint
CREATE UNIQUE INDEX `job_attempts_job_number` ON `job_attempts` (`job_id`,`attempt_number`);--> statement-breakpoint
CREATE TABLE `__new_jobs` (
	`job_id` text PRIMARY KEY NOT NULL,
	`actor_id` text NOT NULL,
	`purpose` text NOT NULL,
	`status` text NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`accepted_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`finished_at` integer,
	`next_attempt_at` integer,
	`last_error_code` text,
	`owner_token` text,
	`generation` integer DEFAULT 0 NOT NULL,
	`lease_until` integer,
	`attempt_deadline` integer,
	CONSTRAINT "jobs_attempt_count_range" CHECK(typeof("__new_jobs"."attempt_count") = 'integer' AND "__new_jobs"."attempt_count" BETWEEN 0 AND 4)
);
--> statement-breakpoint
INSERT INTO `__new_jobs`("job_id", "actor_id", "purpose", "status", "attempt_count", "accepted_at", "updated_at", "finished_at", "next_attempt_at", "last_error_code", "owner_token", "generation", "lease_until", "attempt_deadline") SELECT "job_id", "actor_id", "purpose", "status", "attempt_count", "accepted_at", "updated_at", "finished_at", "next_attempt_at", "last_error_code", "owner_token", "generation", "lease_until", "attempt_deadline" FROM `jobs`;--> statement-breakpoint
DROP TABLE `jobs`;--> statement-breakpoint
ALTER TABLE `__new_jobs` RENAME TO `jobs`;
--> statement-breakpoint
PRAGMA defer_foreign_keys=OFF;
