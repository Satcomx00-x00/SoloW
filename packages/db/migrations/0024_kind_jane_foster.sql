CREATE TABLE `project_view` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`layout` text DEFAULT 'table' NOT NULL,
	`filter` text DEFAULT '{"terms":[]}' NOT NULL,
	`group_by_field_id` text,
	`sort_field` text,
	`sort_direction` text,
	`visible_field_ids` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `project_view_project` ON `project_view` (`project_id`,`position`);--> statement-breakpoint
CREATE INDEX `project_view_ws` ON `project_view` (`workspace_id`);