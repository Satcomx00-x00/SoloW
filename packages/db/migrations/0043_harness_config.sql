-- Harness Configs (Decision 0028, 2026-10-02).
--
-- A harness's own JSON configuration (Claude Code's settings.json, opencode's opencode.json),
-- stored per Workspace instead of read from the operator's home. `agent_profile.harness_config_id`
-- is nullable and null for every existing row: a Profile with no config launches exactly as before.
CREATE TABLE `harness_config` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`harness` text NOT NULL,
	`content` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `harness_config_ws` ON `harness_config` (`workspace_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `harness_config_ws_name` ON `harness_config` (`workspace_id`,`name`);--> statement-breakpoint
ALTER TABLE `agent_profile` ADD `harness_config_id` text REFERENCES harness_config(id);