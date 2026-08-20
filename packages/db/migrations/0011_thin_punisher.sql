PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_task` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`issue_id` text NOT NULL,
	`title` text NOT NULL,
	`state` text DEFAULT 'backlog' NOT NULL,
	`agent_profile_id` text NOT NULL,
	`executor_profile_id` text NOT NULL,
	`failure_reason` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`issue_id`) REFERENCES `issue`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_profile_id`) REFERENCES `agent_profile`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`executor_profile_id`) REFERENCES `executor_profile`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_task`("id", "workspace_id", "issue_id", "title", "state", "agent_profile_id", "executor_profile_id", "failure_reason", "created_at", "updated_at") SELECT "id", "workspace_id", "issue_id", "title", "state", "agent_profile_id", "executor_profile_id", "failure_reason", "created_at", "updated_at" FROM `task`;--> statement-breakpoint
DROP TABLE `task`;--> statement-breakpoint
ALTER TABLE `__new_task` RENAME TO `task`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `task_ws_state` ON `task` (`workspace_id`,`state`);--> statement-breakpoint
CREATE INDEX `task_issue` ON `task` (`issue_id`);