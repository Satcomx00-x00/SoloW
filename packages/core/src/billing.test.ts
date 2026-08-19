import { describe, expect, it } from "bun:test";
import { BillingErrorCode } from "@gatecontrol/contracts";
import {
  classifyRunFailure,
  detectFailureSignal,
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

  it("applies an Executor Profile's environment over the base environment (issue #73)", () => {
    const r = resolveAgentRunEnv({
      authMode: "subscription",
      credentialValue: "sk-ant-oat01-abc",
      baseEnv: { PATH: "/usr/bin", NODE_ENV: "development" },
      profileEnv: { NODE_ENV: "production", GOPATH: "/go" },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data["NODE_ENV"]).toBe("production");
      expect(r.data["GOPATH"]).toBe("/go");
      expect(r.data["PATH"]).toBe("/usr/bin");
    }
  });

  it("AC-6: a profile env cannot set the credential the guard owns", () => {
    // The contract already refuses such a profile, so this is the second lock: a row written
    // before that check existed, or by anything bypassing the API, still cannot divert billing.
    const r = resolveAgentRunEnv({
      authMode: "subscription",
      credentialValue: "sk-ant-oat01-abc",
      baseEnv: {},
      profileEnv: { ANTHROPIC_API_KEY: "sk-metered-billing" },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).not.toHaveProperty("ANTHROPIC_API_KEY");
  });

  it("AC-6: a profile env cannot replace the credential the guard just injected", () => {
    const r = resolveAgentRunEnv({
      authMode: "subscription",
      credentialValue: "sk-ant-oat01-real",
      baseEnv: {},
      profileEnv: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-someone-elses" },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("sk-ant-oat01-real");
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
    expect(classifyRunFailure({ quotaExhausted: true, credentialInvalid: true })).toBe("park");
  });
});

describe("detectFailureSignal", () => {
  it("reads quota exhaustion out of what the agent reported", () => {
    for (const text of [
      "Error: usage limit reached, resets at 18:00",
      "API error 429: too many requests",
      "monthly quota exhausted",
    ]) {
      expect(detectFailureSignal(text)).toEqual({ quotaExhausted: true });
    }
  });

  it("reads a rejected credential out of what the agent reported", () => {
    for (const text of [
      "HTTP 401 Unauthorized",
      "invalid api key provided",
      "OAuth token expired — run `claude login`",
    ]) {
      expect(detectFailureSignal(text)).toEqual({ credentialInvalid: true });
    }
  });

  it("prefers parking when a quota message arrives with a 429", () => {
    expect(detectFailureSignal("429 rate limit: usage limit reached")).toEqual({
      quotaExhausted: true,
    });
  });

  it("leaves an unrecognised failure as a plain failure", () => {
    // A false "park" would strand the Task for hours, so silence must mean `fail`.
    expect(detectFailureSignal("Segmentation fault")).toEqual({});
    expect(detectFailureSignal(null)).toEqual({});
    expect(detectFailureSignal("")).toEqual({});
  });
});
