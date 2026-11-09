CREATE TABLE `evaluation_inputs` (
	`job_id` text PRIMARY KEY NOT NULL,
	`interview_id` text NOT NULL,
	`kind` text NOT NULL,
	`last_sequence` integer NOT NULL,
	`input_json` text NOT NULL,
	`model` text NOT NULL,
	`prompt_version` text NOT NULL,
	`rubric_version` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`job_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`interview_id`) REFERENCES `interviews`(`interview_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "evaluation_inputs_kind" CHECK("evaluation_inputs"."kind" IN ('initial', 'manual')),
	CONSTRAINT "evaluation_inputs_sequence" CHECK(typeof("evaluation_inputs"."last_sequence") = 'integer' AND "evaluation_inputs"."last_sequence" >= 0),
	CONSTRAINT "evaluation_inputs_json" CHECK(json_valid("evaluation_inputs"."input_json"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `evaluation_inputs_one_initial` ON `evaluation_inputs` (`interview_id`) WHERE "evaluation_inputs"."kind" = 'initial';