import { beforeAll, describe, expect, it } from "bun:test";

beforeAll(() => {
  process.env.SOLOW_SECRET_KEY = Buffer.alloc(32, 7).toString("base64");
});

describe("prepareAgentEnv — decrypt + billing integrity", () => {
  it("subscription decrypts the token and strips ANTHROPIC_API_KEY", async () => {
    const { encryptSecret } = await import("@solow/db");
    const { prepareAgentEnv } = await import("./guard.js");
    const ciphertext = encryptSecret("sk-ant-oat01-tok");
    const r = prepareAgentEnv({
      authMode: "subscription",
      secretCiphertext: ciphertext,
      baseEnv: { ANTHROPIC_API_KEY: "leak", PATH: "/bin" },
      subscriptionEnvVar: "CLAUDE_CODE_OAUTH_TOKEN",
      meteredEnvVar: "ANTHROPIC_API_KEY",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-tok");
      expect(r.data).not.toHaveProperty("ANTHROPIC_API_KEY");
    }
  });

  it("errors when no credential", async () => {
    const { prepareAgentEnv } = await import("./guard.js");
    const r = prepareAgentEnv({
      authMode: "api_key",
      secretCiphertext: null,
      baseEnv: {},
      subscriptionEnvVar: "CLAUDE_CODE_OAUTH_TOKEN",
      meteredEnvVar: "ANTHROPIC_API_KEY",
    });
    expect(r.ok).toBe(false);
  });
});
