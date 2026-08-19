CREATE TABLE `agent_catalog` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`key` text NOT NULL,
	`display_name` text NOT NULL,
	`protocol` text NOT NULL,
	`command` text NOT NULL,
	`args_template` text DEFAULT '[]' NOT NULL,
	`install_hint` text,
	`subscription_env_var` text NOT NULL,
	`metered_env_var` text NOT NULL,
	`capabilities` text DEFAULT '{"models":[],"modes":[]}' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `agent_catalog_ws` ON `agent_catalog` (`workspace_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_catalog_ws_key` ON `agent_catalog` (`workspace_id`,`key`);--> statement-breakpoint
-- Hand-edited from the drizzle-kit-generated skeleton above (issue #10). drizzle-kit's own
-- output for the next two steps was `ALTER TABLE agent_profile ADD agent_catalog_id text NOT
-- NULL REFERENCES agent_catalog(id)` — invalid SQLite: a NOT NULL column added by ALTER TABLE
-- must have a constant default, and the value every existing row needs here (which Workspace's
-- `claude_code` row) is not a constant. So: backfill one `claude_code` catalog row per
-- Workspace that already has an Agent Profile, point every such profile at its Workspace's row,
-- then rebuild the table to enforce NOT NULL — SQLite has no ALTER COLUMN SET NOT NULL. No data
-- is lost and no Agent Profile's behaviour changes (AC-5): a legacy `agentKind: "claude_code"`
-- profile becomes a profile pointing at a catalog row describing exactly that agent.
INSERT INTO `agent_catalog`
  (`id`, `workspace_id`, `key`, `display_name`, `protocol`, `command`, `args_template`,
   `subscription_env_var`, `metered_env_var`)
SELECT
  lower(hex(randomblob(16))), `workspace_id`, 'claude_code', 'Claude Code',
  'claude_code_stream_json', 'claude', '[]', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'
FROM (SELECT DISTINCT `workspace_id` FROM `agent_profile`);
--> statement-breakpoint
ALTER TABLE `agent_profile` ADD `agent_catalog_id` text REFERENCES agent_catalog(id);--> statement-breakpoint
UPDATE `agent_profile`
SET `agent_catalog_id` = (
  SELECT `id` FROM `agent_catalog`
  WHERE `agent_catalog`.`workspace_id` = `agent_profile`.`workspace_id`
    AND `agent_catalog`.`key` = 'claude_code'
);--> statement-breakpoint
ALTER TABLE `agent_profile` DROP COLUMN `agent_kind`;--> statement-breakpoint
CREATE TABLE `__new_agent_profile` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`agent_catalog_id` text NOT NULL,
	`auth_mode` text NOT NULL,
	`secret_id` text NOT NULL,
	`concurrency_cap` integer DEFAULT 3 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_catalog_id`) REFERENCES `agent_catalog`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_agent_profile`
  (`id`, `workspace_id`, `name`, `agent_catalog_id`, `auth_mode`, `secret_id`, `concurrency_cap`, `created_at`, `updated_at`)
SELECT `id`, `workspace_id`, `name`, `agent_catalog_id`, `auth_mode`, `secret_id`, `concurrency_cap`, `created_at`, `updated_at`
FROM `agent_profile`;--> statement-breakpoint
DROP TABLE `agent_profile`;--> statement-breakpoint
ALTER TABLE `__new_agent_profile` RENAME TO `agent_profile`;--> statement-breakpoint
CREATE INDEX `agent_profile_ws` ON `agent_profile` (`workspace_id`);
