import { describe, expect, it } from "bun:test";
import { isGeneratedPath, orderForReading, readingRoleOf } from "./change-nature.js";

/**
 * The rule the capture folds by and the panel groups by, pinned on the paths of the change that
 * prompted it: 31 files, 6 473 of 8 370 lines generated, the migration listed beside a
 * 6 194-line snapshot.
 */
describe("isGeneratedPath", () => {
  it("knows a tool's output when it sees its path", () => {
    for (const path of [
      "packages/db/drizzle/meta/0044_snapshot.json",
      "packages/db/drizzle/meta/_journal.json",
      "packages/graphql/src/generated/graphql.ts",
      "packages/graphql/src/generated/persisted-documents.json",
      "apps/web/openapi.json",
      "bun.lock",
      "apps/api/pnpm-lock.yaml",
      "web/dist/app.min.js",
      "src/__snapshots__/x.snap",
    ]) {
      expect(isGeneratedPath(path)).toBe(true);
    }
  });

  it("does not fold what a person — or a harness — wrote by hand", () => {
    for (const path of [
      "packages/db/drizzle/0044_fluffy_spyke.sql",
      "packages/db/src/schema/sectors.ts",
      "apps/web/messages/fr.json",
      "apps/api/test/sectors/source-overrides.test.ts",
      "apps/web/src/components/sectors/sector-source-overrides-editor.tsx",
    ]) {
      expect(isGeneratedPath(path)).toBe(false);
    }
  });
});

describe("reading order", () => {
  it("puts what cannot be undone first and what proves it last", () => {
    const ordered = orderForReading(
      [
        "packages/graphql/src/generated/graphql.ts",
        "apps/api/test/sectors/source-overrides.test.ts",
        "apps/web/src/components/sectors/sector-source-overrides-editor.tsx",
        "apps/web/messages/es.json",
        "apps/api/src/graphql/resolvers/sector-mutations.ts",
        "apps/api/src/services/sector-source-overrides.ts",
        "packages/db/src/sector-overrides.ts",
        "packages/graphql/schema/45-sectors.graphql",
        "packages/db/src/schema/sectors.ts",
        "packages/db/drizzle/0044_fluffy_spyke.sql",
      ].map((path) => ({ path })),
    ).map((f) => readingRoleOf(f.path));
    expect(ordered).toEqual([
      "migration",
      "schema",
      "contract",
      "data",
      "domain",
      "api",
      "ui",
      "copy",
      "test",
      "generated",
    ]);
  });

  it("keeps the given order inside one role", () => {
    const ordered = orderForReading([{ path: "src/b-service.ts" }, { path: "src/a-service.ts" }]);
    expect(ordered.map((f) => f.path)).toEqual(["src/b-service.ts", "src/a-service.ts"]);
  });
});
