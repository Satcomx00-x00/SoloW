ALTER TABLE `session_event` ADD `workflow_step_id` text;--> statement-breakpoint
CREATE INDEX `session_event_step` ON `session_event` (`session_id`,`workflow_step_id`);