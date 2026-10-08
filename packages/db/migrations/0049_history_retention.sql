ALTER TABLE `session` ADD `events_pruned_at` text;--> statement-breakpoint
ALTER TABLE `workspace` ADD `history_retention_days` integer DEFAULT 30;