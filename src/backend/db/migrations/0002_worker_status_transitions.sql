CREATE TABLE `worker_status_transitions` (
	`id` text PRIMARY KEY NOT NULL,
	`worker_id` text NOT NULL,
	`status` text NOT NULL,
	`changed_at` integer NOT NULL,
	FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `worker_status_transitions_worker_id_changed_at_idx` ON `worker_status_transitions` (`worker_id`, `changed_at`);
