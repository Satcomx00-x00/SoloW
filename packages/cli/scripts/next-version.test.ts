import { describe, expect, it } from "bun:test";
import { applyBump, bumpFor, nextVersion, withVersion } from "./next-version.js";

/**
 * The release number, asserted.
 *
 * This is the one part of the release that can be wrong without failing: a bad rule here does not
 * error, it publishes 0.4.2 where 0.5.0 was meant, and npm records that permanently. Nothing
 * downstream can catch it — `publish.yml`'s guard only checks that the tag and the manifest agree
 * with *each other*, which they will.
 */

describe("what a commit asks for", () => {
  it("reads the type", () => {
    expect(bumpFor(["feat(scm): add a driver"])).toBe("minor");
    expect(bumpFor(["fix(db): stop dropping the row"])).toBe("patch");
    expect(bumpFor(["perf(web): stop reloading what the client holds"])).toBe("patch");
  });

  it("releases nothing for a type that changes nothing a consumer sees", () => {
    // The behaviour that keeps a documentation typo from publishing to npm.
    for (const type of ["chore", "docs", "test", "refactor", "style", "build", "ci"]) {
      expect(bumpFor([`${type}(scope): something`])).toBeNull();
    }
  });

  it("takes the largest, not the last", () => {
    // A release carrying one feat among twenty fixes is a minor release, whatever order they
    // were written in.
    expect(bumpFor(["fix: a", "feat: b", "fix: c"])).toBe("minor");
    expect(bumpFor(["feat: a", "fix!: b"])).toBe("major");
  });

  it("ignores a message that is not a Conventional Commit", () => {
    // A merge subject, or a commit from before the convention was adopted. Contributing nothing
    // is right; refusing to release is not.
    expect(bumpFor(["Merge pull request #132 from Satcomx00-x00/release-trigger"])).toBeNull();
    expect(bumpFor(["wip", "", "   "])).toBeNull();
    expect(bumpFor(["Merge pull request #1 from x", "feat: real work"])).toBe("minor");
  });

  it("does not mistake a colon in prose for a type", () => {
    expect(bumpFor(["Revert: this was a mistake"])).toBeNull();
    expect(bumpFor(["note: see the RFC"])).toBeNull();
  });
});

describe("breaking changes", () => {
  it("outranks the type that declared it", () => {
    // `fix!` is a major, not a patch — the break is the larger fact about the commit.
    expect(bumpFor(["fix!: rename the flag"])).toBe("major");
    expect(bumpFor(["feat(cli)!: never download binaries on start"])).toBe("major");
  });

  it("is read from the footer as well as the marker", () => {
    const message = [
      "feat(cli): take Bun from its @oven npm package",
      "",
      "Some explanation of the change.",
      "",
      "BREAKING CHANGE: npx no longer downloads the missing binaries silently.",
    ].join("\n");
    expect(bumpFor([message])).toBe("major");
    // Git trailers cannot hold a space in the key, so the hyphenated spelling is in the spec too.
    expect(bumpFor([message.replace("BREAKING CHANGE:", "BREAKING-CHANGE:")])).toBe("major");
  });

  it("is not read from prose that merely mentions one", () => {
    // Anchored per line: a commit that *discusses* a break must not be read as making one.
    const message = [
      "docs(decisions): record why the cache revalidates",
      "",
      "Explains what would have been a BREAKING CHANGE: had we chosen a TTL.",
    ].join("\n");
    expect(bumpFor([message])).toBeNull();
  });
});

describe("applying it to a version", () => {
  it("moves the digit the bump names", () => {
    expect(applyBump("1.4.1", "patch")).toBe("1.4.2");
    expect(applyBump("1.4.1", "minor")).toBe("1.5.0");
    expect(applyBump("1.4.1", "major")).toBe("2.0.0");
  });

  it("resets the digits below it", () => {
    expect(applyBump("1.4.9", "minor")).toBe("1.5.0");
    expect(applyBump("1.4.9", "major")).toBe("2.0.0");
  });

  it("keeps a 0.x project in 0.x, even on a breaking change", () => {
    // 1.0.0 is a declaration that the interface is stable, not a fact about a diff. No commit
    // message makes that promise on a maintainer's behalf, so a break below 1.0 moves the minor.
    expect(applyBump("0.4.1", "major")).toBe("0.5.0");
    expect(applyBump("0.4.1", "minor")).toBe("0.5.0");
    expect(applyBump("0.4.1", "patch")).toBe("0.4.2");
  });

  it("promotes normally once the project has declared 1.0", () => {
    // The hand edit to 1.0.0 is what switches this on; nothing here does it automatically.
    expect(applyBump("1.0.0", "major")).toBe("2.0.0");
  });

  it("cuts no release when nothing asked for one", () => {
    expect(applyBump("0.4.1", null)).toBeNull();
    expect(nextVersion("0.4.1", ["chore: tidy", "docs: fix a typo"])).toBeNull();
  });

  it("refuses a version it cannot reason about rather than guessing", () => {
    // Silently dropping `-rc.1` would publish a release over the one it was a candidate for.
    expect(() => applyBump("0.4.1-rc.1", "patch")).toThrow(/plain x\.y\.z/);
    expect(() => applyBump("v0.4.1", "patch")).toThrow(/plain x\.y\.z/);
    expect(() => applyBump("0.4", "patch")).toThrow(/plain x\.y\.z/);
  });
});

describe("writing it into the manifest", () => {
  /** The shape of the real file: two-space indent, version third, a nested block further down. */
  const manifest = [
    "{",
    '  "name": "@satcomx00-x00/solow",',
    '  "version": "0.4.1",',
    '  "description": "Solo Workflow — a control plane. Run `npx @satcomx00-x00/solow`.",',
    '  "scripts": {',
    '    "build": "bun run scripts/build.ts"',
    "  },",
    '  "publishConfig": {',
    '    "access": "public"',
    "  }",
    "}",
    "",
  ].join("\n");

  it("changes the version and nothing else, byte for byte", () => {
    const written = withVersion(manifest, "0.5.0");
    expect(written).toBe(manifest.replace('"version": "0.4.1"', '"version": "0.5.0"'));
  });

  it("leaves the em dash alone", () => {
    // A JSON round trip re-escapes it to —, which is an unrelated diff in a release commit.
    expect(withVersion(manifest, "0.5.0")).toContain("Solo Workflow — a control plane");
  });

  it("takes the top-level field, not one nested inside another block", () => {
    const nested = manifest.replace('    "access": "public"', '    "version": "9.9.9"');
    const written = withVersion(nested, "0.5.0");
    expect(written).toContain('  "version": "0.5.0",');
    expect(written).toContain('    "version": "9.9.9"');
  });

  it("throws rather than quietly writing nothing", () => {
    // A release that failed to write the version would tag a manifest still claiming the old one,
    // and publish.yml's guard would then refuse the publish — after the tag was already pushed.
    expect(() => withVersion('{\n  "name": "x"\n}\n', "0.5.0")).toThrow(/no top-level "version"/);
  });
});

describe("the release this change would itself cut", () => {
  it("reads 0.5.0 from the commits since v0.4.1", () => {
    // The real subjects on main between v0.4.1 and this branch: five feats, seven fixes, three
    // perfs and assorted chores. A feat is present, so it is a minor — and 0.4.1 is below 1.0, so
    // it stays there.
    const commits = [
      "perf(scm,web): revalidate provider reads, and stop reloading what the client holds",
      "fix(orchestrator): stop waiting on pipes a killed command left behind",
      "feat(ci): cut the release from the merge that bumps the version",
      "fix(e2e): seed the Agent Profile and Executor the Task form requires",
      "docs(decisions): record why provider reads revalidate rather than expire",
      "chore(repo): stop tracking one machine's local state",
      "test(scm,project): cover the gaps F23a left",
    ];
    expect(nextVersion("0.4.1", commits)).toBe("0.5.0");
  });
});
