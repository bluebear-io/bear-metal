ALTER TABLE `runs` ADD `prompt_tokens` integer;--> statement-breakpoint
ALTER TABLE `runs` ADD `completion_tokens` integer;--> statement-breakpoint
ALTER TABLE `runs` ADD `model_name` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `provider` text;