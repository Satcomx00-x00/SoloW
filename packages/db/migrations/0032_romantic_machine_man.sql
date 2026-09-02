CREATE TABLE `repository_label` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`repository_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text,
	`synced_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`repository_id`) REFERENCES `repository`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `repository_label_repo` ON `repository_label` (`repository_id`);--> statement-breakpoint
CREATE INDEX `repository_label_ws` ON `repository_label` (`workspace_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `repository_label_repo_name` ON `repository_label` (`repository_id`,`name`);--> statement-breakpoint
ALTER TABLE `repository` ADD `labels_synced_at` text;