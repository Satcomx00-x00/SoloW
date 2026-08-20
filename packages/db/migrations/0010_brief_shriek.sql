CREATE TABLE `task_repository` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`task_id` text NOT NULL,
	`repository_id` text NOT NULL,
	`base_ref` text,
	`checkout_branch` text NOT NULL,
	`result_branch` text,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`repository_id`) REFERENCES `repository`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `task_repository_task` ON `task_repository` (`task_id`);--> statement-breakpoint
CREATE INDEX `task_repository_ws` ON `task_repository` (`workspace_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `task_repository_task_repo_branch` ON `task_repository` (`task_id`,`repository_id`,`checkout_branch`);--> statement-breakpoint
CREATE UNIQUE INDEX `task_repository_task_position` ON `task_repository` (`task_id`,`position`);--> statement-breakpoint
-- Hand-appended to the drizzle-kit-generated skeleton above (issue #7, AC-6), following the
-- precedent 0004 set: drizzle-kit generates DDL and cannot generate data movement, and dropping
-- `task.repository_id` without first moving it is a data-loss bug rather than a refactor.
--
-- `task.repository_id` is NOT NULL with a foreign key, so every Task alive today names exactly
-- one Repository. This SELECT has no WHERE and no JOIN, so it produces exactly one attachment
-- per Task — the row counts before and after are provably equal — carrying the same
-- `workspace_id` (the tenant key travels with the row, Principle V), the same `repository_id`,
-- the same `base_ref` verbatim (NULL included: it still means HEAD), the same `result_branch`,
-- and `position` 0.
--
-- `checkout_branch` prefers the recorded `result_branch`: a Task that already finished under the
-- `claude_code` protocol sits on a branch the *agent* named (`gatecontrol-task-<id>`), not the
-- one GateControl derives, and the join row has to point at the branch a reviewer can actually
-- fetch. Where nothing was recorded the derived name is written, which is the name the row would
-- have been given had it been created today — the same default `taskCheckoutBranch` supplies for
-- an attachment that names no branch. Under a protocol whose agent makes its own worktree that
-- name is what marks the attachment as asking for nothing in particular, and the agent is left
-- to name its own branch exactly as it did before the migration; under every other protocol it
-- is the branch `provisionWorktree` asks git for on the next launch.
--
-- The column drops live in the next migration, not this one, so the journal — not statement
-- ordering inside a file drizzle-kit controls — is what guarantees the data moves first.
INSERT INTO `task_repository`
  (`id`, `workspace_id`, `task_id`, `repository_id`, `base_ref`, `checkout_branch`,
   `result_branch`, `position`, `created_at`, `updated_at`)
SELECT
  lower(hex(randomblob(16))), `workspace_id`, `id`, `repository_id`, `base_ref`,
  COALESCE(`result_branch`, 'gatecontrol/task-' || `id`), `result_branch`, 0,
  `created_at`, `updated_at`
FROM `task`;
