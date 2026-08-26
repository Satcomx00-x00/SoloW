ALTER TABLE `issue` ADD `external_state` text;--> statement-breakpoint
ALTER TABLE `issue` ADD `external_parent_id` text;--> statement-breakpoint
CREATE INDEX `issue_ws_parent` ON `issue` (`workspace_id`,`external_parent_id`);