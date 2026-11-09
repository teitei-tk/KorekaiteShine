ALTER TABLE `evaluation_inputs` ADD `retry_of` text;--> statement-breakpoint
CREATE UNIQUE INDEX `evaluation_inputs_retry_of` ON `evaluation_inputs` (`retry_of`);