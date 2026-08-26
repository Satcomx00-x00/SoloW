CREATE TABLE `provider_identity` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`integration_id` text NOT NULL,
	`user_id` text NOT NULL,
	`login` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_identity_owner` ON `provider_identity` (`workspace_id`,`integration_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `provider_identity_ws` ON `provider_identity` (`workspace_id`);