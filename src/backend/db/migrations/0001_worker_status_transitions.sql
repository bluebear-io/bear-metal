CREATE TABLE `worker_status_transitions` (
	`id` text PRIMARY KEY NOT NULL,
	`worker_id` text NOT NULL,
	`status` text NOT NULL,
	`changed_at` integer NOT NULL,
	FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE no action
);
