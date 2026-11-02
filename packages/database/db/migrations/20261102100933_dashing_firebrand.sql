CREATE TABLE `deleted_jobs` (
	`job_id` text PRIMARY KEY NOT NULL,
	`deleted_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `delivery_anomalies` (
	`queue_name` text NOT NULL,
	`message_id` text NOT NULL,
	`code` text NOT NULL,
	`expected_purpose` text NOT NULL,
	`schema_version` integer,
	`job_id` text,
	`observed_purpose` text,
	`first_detected_at` integer NOT NULL,
	`last_detected_at` integer NOT NULL,
	`status` text NOT NULL,
	`resolution` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `delivery_anomalies_queue_message` ON `delivery_anomalies` (`queue_name`,`message_id`);--> statement-breakpoint
CREATE TABLE `execution_slots` (
	`actor_id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`owner_token` text NOT NULL,
	`generation` integer NOT NULL,
	`lease_until` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`job_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `job_attempts` (
	`job_id` text NOT NULL,
	`attempt_number` integer NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`error_code` text,
	`result_json` text,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`job_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `job_attempts_job_number` ON `job_attempts` (`job_id`,`attempt_number`);