import { describe, expect, it } from "bun:test";
import { connectRepositoryInput } from "./repository.js";

/**
 * What a Repository's `location` is allowed to be (issue #96, F07 isolation).
 *
 * The `remote_url` half is covered in `schema.test.ts` beside the rest of the superRefine
 * corpus; this file is about the `local_path` half, which was unconstrained beyond a length
 * bound and reached the Docker executor as a bind source. A relative one is completed from the
 * orchestrator's own working directory, so `"."` named SoloW's own checkout — its source, its
 * configuration and any `.env` beside it — and it was bind-mounted read-write into the agent's
 * container. The guard in `docker.ts` is what actually refuses it; this is the Owner-facing
 * half, so the error lands on the field they typed into.
 */
describe("connectRepositoryInput — a local_path location", () => {
  function parse(location: string, source: "local_path" | "remote_url" = "local_path") {
    return connectRepositoryInput.safeParse({ name: "solow", source, location });
  }

  function message(location: string): string | undefined {
    const result = parse(location);
    return result.success
      ? undefined
      : result.error.issues.find((issue) => issue.path.join(".") === "location")?.message;
  }

  it("accepts the absolute paths an Owner actually types", () => {
    for (const location of ["/home/dev/code/app", "/srv/repos/app", "/Users/dev/code/app"]) {
      expect(parse(location).success).toBe(true);
    }
  });

  it("refuses every relative spelling, because the cwd would supply the rest", () => {
    // `"."` is the one that mattered: it is the orchestrator's own checkout, and it parsed.
    for (const location of [".", "..", "./code/app", "code/app", "~/code/app"]) {
      expect(`${location} → ${message(location) ?? "accepted"}`).toBe(
        `${location} → local_path location must be an absolute path`,
      );
    }
  });

  it("leaves a remote_url alone, which is not a path at all", () => {
    // The rule is keyed on `source`, so a git URL — which starts with neither `/` nor a drive —
    // must not be caught by the sentence written for filesystem paths.
    expect(parse("https://github.com/acme/solow.git", "remote_url").success).toBe(true);
    expect(parse("git@github.com:acme/solow.git", "remote_url").success).toBe(true);
  });
});
