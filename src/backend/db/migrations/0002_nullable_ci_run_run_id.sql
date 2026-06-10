-- Make ci_runs.run_id nullable: PR-observation rows from the scheduler have no
-- in-process `runs` id to point at. SQLite cannot ALTER a NOT NULL constraint
-- away, so recreate the table.
PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `__new_ci_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text NOT NULL,
	`run_id` text,
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
INSERT INTO `__new_ci_runs` SELECT `id`, `ticket_id`, `run_id`, `pr_id`, `status`, `url`, `summary`, `created_at`, `completed_at` FROM `ci_runs`;
--> statement-breakpoint
DROP TABLE `ci_runs`;
--> statement-breakpoint
ALTER TABLE `__new_ci_runs` RENAME TO `ci_runs`;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
