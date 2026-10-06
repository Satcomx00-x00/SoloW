-- OpenCode `--auto` (2026-10-06): approve every permission opencode asks for that its config does
-- not deny. `opencode acp` refuses the flag itself; the orchestrator takes it off the command line
-- and answers the requests as the ACP client (apps/orchestrator/src/harness/client-directives.ts).
--
-- Guarded on the seeded arguments, so a Workspace that chose its own keeps them, and safe to re-run.
UPDATE `agent_catalog` SET `args_template` = '["acp","--auto"]'
WHERE `key` = 'opencode' AND `args_template` = '["acp"]';
