CREATE TABLE `diagnostic_checks` (
	`job_id` text PRIMARY KEY NOT NULL,
	`scenario` text NOT NULL,
	`first_received_at` integer,
	`do_persistence` text NOT NULL,
	`consumer_completion` text NOT NULL,
	`dlq_receipt` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`job_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `diagnostic_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`environment` text NOT NULL,
	`actor_id` text NOT NULL,
	`operation` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`scenario` text NOT NULL,
	`job_id` text NOT NULL,
	`accepted_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`job_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `diagnostic_requests_scope_key` ON `diagnostic_requests` (`environment`,`actor_id`,`operation`,`idempotency_key`);--> statement-breakpoint
CREATE TABLE `job_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`purpose` text NOT NULL,
	`operation` text NOT NULL,
	`generation` integer DEFAULT 0 NOT NULL,
	`scheduled_at` integer NOT NULL,
	`sent_at` integer,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`job_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `job_outbox_operation_generation` ON `job_outbox` (`job_id`,`operation`,`generation`);--> statement-breakpoint
CREATE TABLE `jobs` (
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
	`attempt_deadline` integer
);
