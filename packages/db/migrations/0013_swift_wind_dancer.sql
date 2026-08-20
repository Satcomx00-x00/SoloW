CREATE TABLE `workflow` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `workflow_ws` ON `workflow` (`workspace_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_ws_name` ON `workflow` (`workspace_id`,`name`);--> statement-breakpoint
CREATE TABLE `workflow_step` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`rank` text NOT NULL,
	`name` text NOT NULL,
	`agent_profile_id` text NOT NULL,
	`prompt_template` text DEFAULT '' NOT NULL,
	`gate` text DEFAULT 'human' NOT NULL,
	`advance_on` text DEFAULT 'review' NOT NULL,
	`on_enter` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflow`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_profile_id`) REFERENCES `agent_profile`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `workflow_step_ws` ON `workflow_step` (`workspace_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_step_order` ON `workflow_step` (`workflow_id`,`rank`);--> statement-breakpoint
ALTER TABLE `task` ADD `workflow_id` text REFERENCES workflow(id);--> statement-breakpoint
ALTER TABLE `task` ADD `workflow_step_id` text REFERENCES workflow_step(id);--> statement-breakpoint
ALTER TABLE `task` ADD `workflow_version` integer;--> statement-breakpoint
ALTER TABLE `task` ADD `workflow_handoff` text;--> statement-breakpoint
CREATE INDEX `task_workflow` ON `task` (`workspace_id`,`workflow_id`);