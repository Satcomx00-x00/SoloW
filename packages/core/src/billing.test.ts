import { describe, expect, it } from "bun:test";
import { BillingErrorCode } from "@gatecontrol/contracts";
import {
  classifyRunFailure,
  resolveAgentRunEnv,
  withinConcurrencyCap,
} from "./billing.js";

describe("resolveAgentRunEnv — billing integrity (Principle IV)", () => {
  it("subscription mode injects the OAuth token and STRIPS ANTHROPIC_API_KEY", () => {
    const r = resolveAgentRunEnv({
      authMode: "subscription",
      credentialValue: "sk-ant-oat01-abc",
      baseEnv: { ANTHROPIC_API_KEY: "sk-should-be-removed", PATH: "/usr/bin" },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("sk-ant-oat01-abc");
      expect(r.data).not.toHaveProperty("ANTHROPIC_API_KEY");
      expect(r.data["PATH"]).toBe("/usr/bin");
    }
  });

  it("api_key mode injects the key and drops any stale OAuth token", () => {
    const r = resolveAgentRunEnv({
      authMode: "api_key",
      credentialValue: "sk-ant-key",
      baseEnv: { CLAUDE_CODE_OAUTH_TOKEN: "stale" },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data["ANTHROPIC_API_KEY"]).toBe("sk-ant-key");
      expect(r.data).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    }
  });

  it("errors when the credential is missing", () => {
    const r = resolveAgentRunEnv({
      authMode: "subscription",
      credentialValue: null,
      baseEnv: {},
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(BillingErrorCode.MissingCredential);
  });
});

describe("withinConcurrencyCap", () => {
  it("permits below the cap and blocks at/over it", () => {
    expect(withinConcurrencyCap(3, 2)).toBe(true);
    expect(withinConcurrencyCap(3, 3)).toBe(false);
    expect(withinConcurrencyCap(3, 4)).toBe(false);
  });
});

describe("classifyRunFailure", () => {
  it("quota → park, invalid credential → credential_expired, else fail", () => {
    expect(classifyRunFailure({ quotaExhausted: true })).toBe("park");
    expect(classifyRunFailure({ credentialInvalid: true })).toBe("credential_expired");
    expect(classifyRunFailure({})).toBe("fail");
    // quota takes precedence over other signals
    expect(classifyRunFailure({ quotaExhausted: true, credentialInvalid: true })).toBe(
      "park",
    );
  });
});
