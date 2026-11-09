CREATE TABLE `material_analyses` (
	`analysis_id` text PRIMARY KEY NOT NULL,
	`actor_id` text NOT NULL,
	`material_hash` text NOT NULL,
	`candidates_json` text NOT NULL,
	`model` text NOT NULL,
	`prompt_version` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	CONSTRAINT "material_analyses_json" CHECK(json_valid("material_analyses"."candidates_json")),
	CONSTRAINT "material_analyses_expiry" CHECK("material_analyses"."expires_at" > "material_analyses"."created_at")
);
--> statement-breakpoint
CREATE INDEX `material_analyses_expiry` ON `material_analyses` (`expires_at`);