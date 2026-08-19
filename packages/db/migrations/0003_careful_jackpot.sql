CREATE TABLE `change_request` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`repository_id` text NOT NULL,
	`integration_id` text NOT NULL,
	`external_id` text NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`state` text NOT NULL,
	`url` text NOT NULL,
	`head_ref` text NOT NULL,
	`base_ref` text NOT NULL,
	`author_login` text,
	`synced_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`repository_id`) REFERENCES `repository`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`integration_id`) REFERENCES `integration`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `change_request_repo` ON `change_request` (`repository_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `change_request_integration_external` ON `change_request` (`integration_id`,`external_id`);--> statement-breakpoint
CREATE TABLE `integration` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`provider` text NOT NULL,
	`secret_id` text NOT NULL,
	`base_url` text,
	`write_back_enabled` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `integration_ws` ON `integration` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `repository_branch` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`repository_id` text NOT NULL,
	`name` text NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`head_sha` text NOT NULL,
	`head_committed_at` text,
	`synced_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`repository_id`) REFERENCES `repository`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `repository_branch_repo` ON `repository_branch` (`repository_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `repository_branch_repo_name` ON `repository_branch` (`repository_id`,`name`);--> statement-breakpoint
ALTER TABLE `issue` ADD `source` text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE `issue` ADD `integration_id` text REFERENCES integration(id);--> statement-breakpoint
ALTER TABLE `issue` ADD `repository_id` text REFERENCES repository(id);--> statement-breakpoint
ALTER TABLE `issue` ADD `external_id` text;--> statement-breakpoint
ALTER TABLE `issue` ADD `external_number` integer;--> statement-breakpoint
ALTER TABLE `issue` ADD `external_url` text;--> statement-breakpoint
ALTER TABLE `issue` ADD `synced_at` text;--> statement-breakpoint
CREATE UNIQUE INDEX `issue_integration_external` ON `issue` (`integration_id`,`external_id`);--> statement-breakpoint
ALTER TABLE `repository` ADD `integration_id` text REFERENCES integration(id);--> statement-breakpoint
ALTER TABLE `repository` ADD `external_full_name` text;