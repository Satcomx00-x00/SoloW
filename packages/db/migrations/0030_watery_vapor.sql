ALTER TABLE `issue` ADD `assignees` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `issue` ADD `milestone` text;