CREATE TABLE `project` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`integration_id` text NOT NULL,
	`provider_project_id` text NOT NULL,
	`title` text NOT NULL,
	`synced_at` text,
	`sync_cursor` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`integration_id`) REFERENCES `integration`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `project_ws` ON `project` (`workspace_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `project_integration_provider` ON `project` (`integration_id`,`provider_project_id`);--> statement-breakpoint
CREATE TABLE `project_field` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`project_id` text NOT NULL,
	`provider_field_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`options` text DEFAULT '[]' NOT NULL,
	`iterations` text DEFAULT '[]' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`read_only` integer DEFAULT false NOT NULL,
	`read_only_reason` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `project_field_project` ON `project_field` (`project_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `project_field_provider` ON `project_field` (`project_id`,`provider_field_id`);--> statement-breakpoint
CREATE TABLE `project_item` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`project_id` text NOT NULL,
	`issue_id` text NOT NULL,
	`provider_item_id` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`archived_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`issue_id`) REFERENCES `issue`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `project_item_project` ON `project_item` (`project_id`,`position`);--> statement-breakpoint
CREATE INDEX `project_item_issue` ON `project_item` (`issue_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `project_item_provider` ON `project_item` (`project_id`,`provider_item_id`);--> statement-breakpoint
CREATE TABLE `project_value` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`item_id` text NOT NULL,
	`field_id` text NOT NULL,
	`value` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`item_id`) REFERENCES `project_item`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`field_id`) REFERENCES `project_field`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_value_cell` ON `project_value` (`item_id`,`field_id`);--> statement-breakpoint
CREATE INDEX `project_value_field` ON `project_value` (`field_id`);