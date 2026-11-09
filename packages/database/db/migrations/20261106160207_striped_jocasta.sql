CREATE TABLE `usage_reservations` (
	`reservation_id` text PRIMARY KEY NOT NULL,
	`actor_id` text NOT NULL,
	`day` text NOT NULL,
	`kind` text NOT NULL,
	`amount` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "usage_reservations_kind" CHECK("usage_reservations"."kind" IN ('analysis', 'audio', 'evaluation')),
	CONSTRAINT "usage_reservations_amount" CHECK(typeof("usage_reservations"."amount") = 'integer' AND "usage_reservations"."amount" >= 0)
);
--> statement-breakpoint
CREATE INDEX `usage_reservations_actor_day_kind` ON `usage_reservations` (`actor_id`,`day`,`kind`);