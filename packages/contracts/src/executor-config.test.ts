import { describe, expect, it } from "bun:test";
import {
  DEFAULT_EXECUTOR_CONFIG,
  executorConfigSchema,
  executorKindSchema,
  GUARDED_ENV_VARS,
} from "./executor-config.js";
import { createExecutorProfileInput } from "./profile.js";

const parse = (value: unknown) => executorConfigSchema.safeParse(value);

describe("AC-1/AC-2 — configuration is validated per Executor kind", () => {
  it("accepts each kind's own shape", () => {
    expect(parse({ kind: "local" }).success).toBe(true);
    expect(parse({ kind: "docker", image: "oven/bun:1.3" }).success).toBe(true);
    expect(parse({ kind: "ssh", host: "build-01", user: "ci", keySecretId: "sec_1" }).success).toBe(
      true,
    );
    expect(
      parse({ kind: "cloud", provider: "fly", size: "shared-1x", credentialSecretId: "sec_2" })
        .success,
    ).toBe(true);
  });

  it("rejects a configuration missing its kind's required fields", () => {
    expect(parse({ kind: "docker" }).success).toBe(false);
    expect(parse({ kind: "ssh", host: "build-01" }).success).toBe(false);
    expect(parse({ kind: "cloud", provider: "fly" }).success).toBe(false);
  });

  it("rejects fields belonging to a different kind — the discriminant decides the shape", () => {
    // An SSH host on a Docker profile is not a harmless extra: accepting it would let a config
    // claim one runtime and describe another.
    expect(parse({ kind: "docker", image: "x", host: "build-01" }).success).toBe(false);
    expect(parse({ kind: "local", image: "oven/bun:1.3" }).success).toBe(false);
  });

  it("rejects an unknown kind rather than falling back to local", () => {
    expect(parse({ kind: "kubernetes", image: "x" }).success).toBe(false);
  });

  it("fills the per-kind defaults", () => {
    const ssh = parse({ kind: "ssh", host: "h", user: "u", keySecretId: "s" });
    expect(ssh.success && ssh.data.kind === "ssh" && ssh.data.port).toBe(22);
    const docker = parse({ kind: "docker", image: "x" });
    expect(docker.success && docker.data.kind === "docker" && docker.data.mounts).toEqual([]);
    expect(parse({ kind: "local" }).success && parse({ kind: "local" }).data).toEqual({
      kind: "local",
      env: {},
    });
  });
});

describe("AC-3 — credentials are references, never values", () => {
  it("refuses an inline credential instead of silently dropping it", () => {
    // Zod strips unknown keys by default; these members are `.strict()` precisely so a pasted
    // key is a visible error. Silently discarding it would teach the user it was accepted.
    for (const field of ["privateKey", "password", "token", "apiKey"]) {
      const result = parse({
        kind: "ssh",
        host: "build-01",
        user: "ci",
        keySecretId: "sec_1",
        [field]: "-----BEGIN OPENSSH PRIVATE KEY-----",
      });
      expect(result.success).toBe(false);
    }
  });

  it("carries no credential value on a valid configuration", () => {
    const result = parse({ kind: "ssh", host: "h", user: "u", keySecretId: "sec_1" });
    expect(JSON.stringify(result.success && result.data)).not.toContain("BEGIN OPENSSH");
  });
});

describe("AC-6 — a profile cannot reach the credential environment", () => {
  it.each([...GUARDED_ENV_VARS])("rejects a profile env that sets %s", (name: string) => {
    const result = parse({ kind: "local", env: { [name]: "sk-ant-smuggled" } });
    expect(result.success).toBe(false);
  });

  it("still accepts ordinary runtime variables", () => {
    const result = parse({ kind: "local", env: { NODE_ENV: "test", CI: "1" } });
    expect(result.success && result.data.env).toEqual({ NODE_ENV: "test", CI: "1" });
  });

  it("rejects a name that is not a legal environment variable", () => {
    expect(parse({ kind: "local", env: { "not a name": "x" } }).success).toBe(false);
    expect(parse({ kind: "local", env: { "1LEADING_DIGIT": "x" } }).success).toBe(false);
  });
});

describe("AC-5 — a new kind is a union member, not a migration", () => {
  it("keeps the kind enum and the union's discriminants naming the same set", () => {
    const fromUnion = executorConfigSchema.options.map((o) => o.shape.kind.value).sort();
    expect(fromUnion).toEqual([...executorKindSchema.options].sort());
  });
});

describe("createExecutorProfileInput", () => {
  it("defaults to a local configuration when the caller states only a name", () => {
    const parsed = createExecutorProfileInput.parse({ name: "Local executor" });
    expect(parsed.config).toEqual(DEFAULT_EXECUTOR_CONFIG);
  });

  it("carries the kind inside the configuration, so the two cannot disagree", () => {
    const parsed = createExecutorProfileInput.parse({
      name: "Container",
      config: { kind: "docker", image: "oven/bun:1.3" },
    });
    expect(parsed.config.kind).toBe("docker");
  });
});
