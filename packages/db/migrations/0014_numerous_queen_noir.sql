ALTER TABLE `task` ADD `workflow_pending_handoff` text;--> statement-breakpoint
ALTER TABLE `task` ADD `workflow_decision_id` text;--> statement-breakpoint
CREATE INDEX `task_workflow_step` ON `task` (`workspace_id`,`workflow_step_id`);