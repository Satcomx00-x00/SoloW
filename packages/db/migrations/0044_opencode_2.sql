-- OpenCode 2 (2026-10-02): SoloW now bundles @opencode/cli@2.0.22 instead of opencode-ai@1.18.33.
--
-- Existing `opencode` rows still carry 0042's pin, which the bundled 2.x build meets, but the
-- seeded minimum must name the build that was verified, and the install hint must name the package
-- that is actually installed. Guarded on the old seeded values, so a Workspace that chose its own
-- pin or hint keeps it, and the statements are safe to re-run.
UPDATE `agent_catalog` SET `min_version` = '2.0.22'
WHERE `key` = 'opencode' AND `min_version` = '1.18.33';--> statement-breakpoint
UPDATE `agent_catalog` SET `install_hint` = 'SoloW installs @opencode/cli@2.0.22 itself: reinstall its dependencies (bun install from source, or npx @satcomx00-x00/solow@latest)'
WHERE `key` = 'opencode' AND `install_hint` = 'SoloW installs opencode-ai@1.18.33 itself: reinstall its dependencies (bun install from source, or npx @satcomx00-x00/solow@latest)';
