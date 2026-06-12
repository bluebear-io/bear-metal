CREATE TABLE `worker_state_transitions` (
	`id` text PRIMARY KEY NOT NULL,
	`worker_id` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE no action
);
