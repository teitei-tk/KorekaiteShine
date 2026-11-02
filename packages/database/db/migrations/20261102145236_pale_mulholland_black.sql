CREATE TABLE `dlq_receipts` (
	`queue_name` text NOT NULL,
	`message_id` text NOT NULL,
	`job_id` text NOT NULL,
	`purpose` text NOT NULL,
	`observed_status` text NOT NULL,
	`first_received_at` integer NOT NULL,
	`last_received_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dlq_receipts_queue_message` ON `dlq_receipts` (`queue_name`,`message_id`);