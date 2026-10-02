import type { HarnessConfigContent, HarnessConfigHarness } from "@solow/contracts";
import { and, eq } from "drizzle-orm";
import type { Db } from "./index.js";
import { harnessConfig } from "./schema.js";

export interface HarnessConfigForRun {
  id: string;
  name: string;
  harness: HarnessConfigHarness;
  content: HarnessConfigContent;
}

/**
 * The Harness Config a run launches with (Decision 0028), read at launch so an edit is the next
 * round's configuration. Workspace-scoped: an id from another tenant reads as no config
 * (Principle V). Null id, or a row since deleted, is the harness's own defaults.
 */
export async function loadHarnessConfigForRun(
  db: Db,
  workspaceId: string,
  harnessConfigId: string | null,
): Promise<HarnessConfigForRun | null> {
  if (!harnessConfigId) return null;
  const [row] = await db
    .select({
      id: harnessConfig.id,
      name: harnessConfig.name,
      harness: harnessConfig.harness,
      content: harnessConfig.content,
    })
    .from(harnessConfig)
    .where(and(eq(harnessConfig.workspaceId, workspaceId), eq(harnessConfig.id, harnessConfigId)))
    .limit(1);
  return row ?? null;
}
