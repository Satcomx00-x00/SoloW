CREATE TABLE `session_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`session_id` text NOT NULL,
	`task_id` text NOT NULL,
	`agent_profile_id` text NOT NULL,
	`seq` integer NOT NULL,
	`model` text,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`reported` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_profile_id`) REFERENCES `agent_profile`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_usage_seq` ON `session_usage` (`session_id`,`seq`);--> statement-breakpoint
CREATE INDEX `session_usage_ws_at` ON `session_usage` (`workspace_id`,`created_at`);