CREATE TABLE `ci_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text NOT NULL,
	`run_id` text NOT NULL,
	`pr_id` text,
	`status` text NOT NULL,
	`url` text,
	`summary` text,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`pr_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text,
	`run_id` text,
	`worker_id` text,
	`source` text NOT NULL,
	`type` text NOT NULL,
	`summary` text NOT NULL,
	`payload_json` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `pull_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`head_ref` text NOT NULL,
	`state` text NOT NULL,
	`draft` integer NOT NULL,
	`merged` integer NOT NULL,
	`url` text NOT NULL,
	`last_run_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`last_run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text NOT NULL,
	`attempt_number` integer NOT NULL,
	`worker_id` text,
	`trigger` text NOT NULL,
	`status` text NOT NULL,
	`context_json` text,
	`started_at` integer,
	`ended_at` integer,
	`stop_reason` text,
	`error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `tickets` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`url` text NOT NULL,
	`branch_name` text NOT NULL,
	`linear_status_name` text NOT NULL,
	`linear_status_type` text NOT NULL,
	`labels_json` text DEFAULT '[]' NOT NULL,
	`bm_status` text NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE TABLE `workers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`current_run_id` text,
	`last_heartbeat_at` integer,
	`started_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
