DROP INDEX IF EXISTS `issue_ws_status`;--> statement-breakpoint
ALTER TABLE `issue` ADD `status_override` text;--> statement-breakpoint
ALTER TABLE `issue` ADD `status_override_at` text;--> statement-breakpoint
ALTER TABLE `issue` ADD `status_override_by` text;--> statement-breakpoint
CREATE INDEX `issue_ws_status` ON `issue` (`workspace_id`,`status_override`);