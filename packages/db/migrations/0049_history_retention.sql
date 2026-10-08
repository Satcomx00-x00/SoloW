-- History retention (Decision 0032): a finished Task's transcript is removed once it has been
-- finished for longer than its Workspace's window.
--
-- The column default (30 days) is for Workspaces created from now on. Every Workspace that already
-- exists is set to null (keep forever) and flagged, so the first hourly sweep after an upgrade
-- deletes nothing the Owner has not chosen to delete; Settings and History ask them to choose.
-- On a fresh install there are no rows yet and the UPDATE touches nothing.
ALTER TABLE `session` ADD `events_pruned_at` text;--> statement-breakpoint
ALTER TABLE `workspace` ADD `history_retention_days` integer DEFAULT 30;--> statement-breakpoint
ALTER TABLE `workspace` ADD `history_retention_notice` integer DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE `workspace` SET `history_retention_days` = NULL, `history_retention_notice` = true;
