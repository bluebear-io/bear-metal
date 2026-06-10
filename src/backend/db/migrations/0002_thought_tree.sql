CREATE TABLE `run_tool_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`tool_name` text NOT NULL,
	`args_json` text NOT NULL,
	`result_text` text,
	`result_status` text,
	`output_size` integer,
	`thought_text` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
