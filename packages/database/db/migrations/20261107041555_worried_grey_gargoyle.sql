CREATE TABLE `deleted_interviews` (
	`interview_id` text PRIMARY KEY NOT NULL,
	`actor_id` text NOT NULL,
	`deleted_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `deleted_jobs` ADD `interview_id` text;