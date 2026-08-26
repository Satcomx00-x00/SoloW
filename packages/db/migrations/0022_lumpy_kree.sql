ALTER TABLE `repository` ADD `issues_synced_at` text;--> statement-breakpoint
ALTER TABLE `repository` ADD `sync_stale_since` text;--> statement-breakpoint
ALTER TABLE `repository` ADD `sync_stale_reason` text;