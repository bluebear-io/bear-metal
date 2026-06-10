CREATE TABLE `ci_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`ci_run_id` text NOT NULL,
	`source` text NOT NULL,
	`external_id` text NOT NULL,
	`name` text NOT NULL,
	`conclusion` text,
	`details_url` text,
	`summary` text,
	`annotations_json` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`ci_run_id`) REFERENCES `ci_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `review_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`pr_id` text NOT NULL,
	`path` text,
	`line` integer,
	`is_resolved` integer NOT NULL,
	`comments_json` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`pr_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `runs` ADD `prompt_tokens` integer;--> statement-breakpoint
ALTER TABLE `runs` ADD `completion_tokens` integer;--> statement-breakpoint
ALTER TABLE `runs` ADD `model_name` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `provider` text;