CREATE TABLE `run_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`message` text NOT NULL,
	`level` text NOT NULL,
	`timestamp` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
