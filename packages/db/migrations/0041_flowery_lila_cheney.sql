ALTER TABLE `task` ADD `parent_task_id` text REFERENCES task(id);--> statement-breakpoint
ALTER TABLE `task` ADD `fork_session_id` text;--> statement-breakpoint
ALTER TABLE `task` ADD `fork_seq` integer;--> statement-breakpoint
ALTER TABLE `task` ADD `fork_hash` text;--> statement-breakpoint
CREATE INDEX `task_parent` ON `task` (`workspace_id`,`parent_task_id`);