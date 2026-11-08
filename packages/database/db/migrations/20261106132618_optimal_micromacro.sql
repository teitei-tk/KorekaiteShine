CREATE TABLE `playback_receipts` (
	`interview_id` text NOT NULL,
	`generation` integer NOT NULL,
	`audio_offset_ms` integer NOT NULL,
	`received_at` integer NOT NULL,
	FOREIGN KEY (`interview_id`) REFERENCES `interviews`(`interview_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "playback_receipts_counters" CHECK(typeof("playback_receipts"."generation") = 'integer' AND "playback_receipts"."generation" > 0
      AND typeof("playback_receipts"."audio_offset_ms") = 'integer' AND "playback_receipts"."audio_offset_ms" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `playback_receipts_generation` ON `playback_receipts` (`interview_id`,`generation`);--> statement-breakpoint
CREATE TABLE `transcript_fragments` (
	`fragment_id` text PRIMARY KEY NOT NULL,
	`interview_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`generation` integer NOT NULL,
	`source_event_id` text NOT NULL,
	`speaker` text NOT NULL,
	`content` text NOT NULL,
	`source_start_ms` integer,
	`source_end_ms` integer,
	`received_at` integer NOT NULL,
	FOREIGN KEY (`interview_id`) REFERENCES `interviews`(`interview_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "transcript_fragments_speaker" CHECK("transcript_fragments"."speaker" IN ('user', 'assistant')),
	CONSTRAINT "transcript_fragments_counters" CHECK(typeof("transcript_fragments"."sequence") = 'integer' AND "transcript_fragments"."sequence" > 0
      AND typeof("transcript_fragments"."generation") = 'integer' AND "transcript_fragments"."generation" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transcript_fragments_sequence` ON `transcript_fragments` (`interview_id`,`sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `transcript_fragments_source` ON `transcript_fragments` (`interview_id`,`generation`,`source_event_id`);