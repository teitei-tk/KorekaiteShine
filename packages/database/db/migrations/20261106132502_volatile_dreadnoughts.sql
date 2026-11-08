CREATE TABLE `interviews` (
	`interview_id` text PRIMARY KEY NOT NULL,
	`actor_id` text NOT NULL,
	`material_hash` text NOT NULL,
	`theme_title` text NOT NULL,
	`theme_heading` text NOT NULL,
	`theme_excerpt` text NOT NULL,
	`background` text NOT NULL,
	`status` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`generation` integer DEFAULT 0 NOT NULL,
	`active_ms` integer DEFAULT 0 NOT NULL,
	`active_since` integer,
	`deadline` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ended_at` integer,
	CONSTRAINT "interviews_status" CHECK("interviews"."status" IN ('ready', 'connecting', 'active', 'paused', 'reconnecting', 'ending', 'ended')),
	CONSTRAINT "interviews_counters" CHECK(typeof("interviews"."revision") = 'integer' AND "interviews"."revision" >= 0
        AND typeof("interviews"."generation") = 'integer' AND "interviews"."generation" >= 0
        AND typeof("interviews"."active_ms") = 'integer' AND "interviews"."active_ms" BETWEEN 0 AND 1200000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `interviews_one_open_per_actor` ON `interviews` (`actor_id`) WHERE "interviews"."status" != 'ended';