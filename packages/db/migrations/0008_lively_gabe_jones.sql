CREATE TABLE `task_dependency` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`task_id` text NOT NULL,
	`blocked_by_task_id` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`blocked_by_task_id`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_dependency_edge` ON `task_dependency` (`task_id`,`blocked_by_task_id`);--> statement-breakpoint
CREATE INDEX `task_dependency_blocked_by` ON `task_dependency` (`blocked_by_task_id`);--> statement-breakpoint
CREATE INDEX `task_dependency_ws` ON `task_dependency` (`workspace_id`);