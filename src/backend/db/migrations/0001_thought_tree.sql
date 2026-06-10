CREATE TABLE `run_tool_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`kind` text NOT NULL,
	`tool_name` text,
	`params_json` text,
	`status` text,
	`result_text` text,
	`result_size` integer,
	`thought_text` text,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_run_tool_calls_run` ON `run_tool_calls` (`run_id`, `sequence`);
