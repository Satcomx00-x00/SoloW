import "server-only";
import type { Db } from "@gatecontrol/db";

/**
 * Every DAL call takes a RequestContext carrying the authenticated identity and the
 * tenant key. `workspaceId` comes from the session — never from client input
 * (constitution Principle V).
 */
export interface RequestContext {
  db: Db;
  workspaceId: string;
  userId: string;
}
