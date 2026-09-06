CREATE TABLE `mcp_server` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`transport` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `mcp_server_ws` ON `mcp_server` (`workspace_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_server_ws_name` ON `mcp_server` (`workspace_id`,`name`);--> statement-breakpoint
CREATE TABLE `skill` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`source` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `skill_ws` ON `skill` (`workspace_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `skill_ws_name` ON `skill` (`workspace_id`,`name`);--> statement-breakpoint
ALTER TABLE `workflow_step` ADD `mcp_server_ids` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `workflow_step` ADD `skill_ids` text DEFAULT '[]' NOT NULL;