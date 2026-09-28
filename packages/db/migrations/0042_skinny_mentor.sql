-- The oldest build of a harness a run accepts (2026-09-28).
--
-- `min_version` is checked against the ACP handshake's `agentInfo.version` before a session is
-- opened (`@solow/acp`'s `requireMinimumVersion`), so a Task on a harness older than the one this
-- build was verified against fails naming both versions instead of half-working on a wire shape
-- it does not send. Null is "no pin", which is every row a Workspace added itself.
--
-- The backfill gives existing `opencode` rows the pin `ensureDefaultHarnessCatalog` now seeds —
-- the same reason 0031 backfilled the row itself: the defaults only run at sign-up and in the dev
-- seed. Guarded on NULL so a Workspace that already chose its own pin keeps it, and so the
-- statement is safe to re-run. The install hint is filled the same way, because the version
-- refusal quotes it as the way to upgrade.
ALTER TABLE `agent_catalog` ADD `min_version` text;--> statement-breakpoint
UPDATE `agent_catalog` SET `min_version` = '1.18.33'
WHERE `key` = 'opencode' AND `min_version` IS NULL;--> statement-breakpoint
UPDATE `agent_catalog` SET `install_hint` = 'npm install -g opencode-ai@latest'
WHERE `key` = 'opencode' AND `install_hint` IS NULL;
