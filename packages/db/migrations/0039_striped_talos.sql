ALTER TABLE `task` ADD `deleted_at` text;--> statement-breakpoint
CREATE INDEX `task_ws_deleted` ON `task` (`workspace_id`,`deleted_at`);