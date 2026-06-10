ALTER TABLE `pull_requests` ADD `owner` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `repo` text DEFAULT '' NOT NULL;