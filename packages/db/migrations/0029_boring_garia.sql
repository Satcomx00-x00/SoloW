CREATE TABLE `project_repository` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`project_id` text NOT NULL,
	`repository_id` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`repository_id`) REFERENCES `repository`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `project_repository_ws` ON `project_repository` (`workspace_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `project_repository_pair` ON `project_repository` (`project_id`,`repository_id`);--> statement-breakpoint
CREATE INDEX `project_repository_repository` ON `project_repository` (`repository_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_project` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`integration_id` text,
	`provider_project_id` text,
	`title` text NOT NULL,
	`synced_at` text,
	`sync_cursor` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`integration_id`) REFERENCES `integration`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_project`("id", "workspace_id", "integration_id", "provider_project_id", "title", "synced_at", "sync_cursor", "created_at", "updated_at") SELECT "id", "workspace_id", "integration_id", "provider_project_id", "title", "synced_at", "sync_cursor", "created_at", "updated_at" FROM `project`;--> statement-breakpoint
DROP TABLE `project`;--> statement-breakpoint
ALTER TABLE `__new_project` RENAME TO `project`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `project_ws` ON `project` (`workspace_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `project_integration_provider` ON `project` (`integration_id`,`provider_project_id`);