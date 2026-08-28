-- Give every existing Workspace the `opencode` catalog row (2026-08-28).
--
-- `ensureDefaultAgentCatalog` seeds the defaults, but it only runs at sign-up and in the dev
-- seed — so a Workspace that already exists would never see a default added after it was
-- created. Migration 0004 had exactly this problem when the catalog was introduced and solved it
-- the same way, backfilling `claude_code` for Workspaces that predated it.
--
-- opencode speaks ACP natively (`opencode acp` is an Agent Client Protocol server at protocol
-- version 1, which is what `@solow/acp` implements), so this is a catalog row and nothing else:
-- no new package, no runner, no protocol member.
--
-- Guarded by NOT EXISTS rather than a plain insert: this must be a no-op for a Workspace created
-- after the default existed, and re-runnable without producing a second row.
INSERT INTO `agent_catalog`
  (`id`, `workspace_id`, `key`, `display_name`, `protocol`, `command`, `args_template`,
   `subscription_env_var`, `metered_env_var`)
SELECT
  lower(hex(randomblob(16))), `w`.`id`, 'opencode', 'opencode',
  'acp', 'opencode', '["acp"]', 'OPENCODE_API_KEY', 'ANTHROPIC_API_KEY'
FROM `workspace` AS `w`
WHERE NOT EXISTS (
  SELECT 1 FROM `agent_catalog` AS `c`
  WHERE `c`.`workspace_id` = `w`.`id` AND `c`.`key` = 'opencode'
);
