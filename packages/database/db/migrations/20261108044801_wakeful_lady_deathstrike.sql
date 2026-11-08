CREATE TABLE `audio_usage_periods` (
	`actor_id` text NOT NULL,
	`interview_id` text NOT NULL,
	`generation` integer NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer NOT NULL,
	CONSTRAINT "audio_usage_period_order" CHECK("audio_usage_periods"."ended_at" >= "audio_usage_periods"."started_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audio_usage_period_generation` ON `audio_usage_periods` (`interview_id`,`generation`);--> statement-breakpoint
CREATE INDEX `audio_usage_period_actor_end` ON `audio_usage_periods` (`actor_id`,`ended_at`);