import { describe, expect, it } from "bun:test";
import { BillingErrorCode } from "@gatecontrol/contracts";
import {
  classifyRunFailure,
  detectFailureSignal,
  resolveAgentRunEnv,
  withinConcurrencyCap,
} from "./billing.js";

// Claude Code's own variable names, used throughout as a stand-in for "whatever the running
// Agent's catalog row declares" (issue #10) — the point under test is that the guard uses the
// parameters, not that it happens to know Claude Code's names.
const CLAUDE_CODE_VARS = {
  subscriptionEnvVar: "CLAUDE_CODE_OAUTH_TOKEN",
  meteredEnvVar: "ANTHROPIC_API_KEY",
};

describe("resolveAgentRunEnv — billing integrity (Principle IV)", () => {
  it("subscription mode injects the subscription variable and STRIPS the metered one", () => {
    const r = resolveAgentRunEnv({
      authMode: "subscription",
      credentialValue: "sk-ant-oat01-abc",
      baseEnv: { ANTHROPIC_API_KEY: "sk-should-be-removed", PATH: "/usr/bin" },
      ...CLAUDE_CODE_VARS,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("sk-ant-oat01-abc");
      expect(r.data).not.toHaveProperty("ANTHROPIC_API_KEY");
      expect(r.data["PATH"]).toBe("/usr/bin");
    }
  });

  it("api_key mode injects the metered variable and drops any stale subscription one", () => {
    const r = resolveAgentRunEnv({
      authMode: "api_key",
      credentialValue: "sk-ant-key",
      baseEnv: { CLAUDE_CODE_OAUTH_TOKEN: "stale" },
      ...CLAUDE_CODE_VARS,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data["ANTHROPIC_API_KEY"]).toBe("sk-ant-key");
      expect(r.data).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    }
  });

  it("uses whichever variable names the running Agent's catalog row declares", () => {
    // A hypothetical second agent with entirely different variable names — proves the guard is
    // driven by its parameters and not still secretly hardcoded to Claude Code's.
    const r = resolveAgentRunEnv({
      authMode: "subscription",
      credentialValue: "tok-123",
      baseEnv: { OTHER_AGENT_API_KEY: "should-be-stripped" },
      subscriptionEnvVar: "OTHER_AGENT_OAUTH_TOKEN",
      meteredEnvVar: "OTHER_AGENT_API_KEY",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data["OTHER_AGENT_OAUTH_TOKEN"]).toBe("tok-123");
      expect(r.data).not.toHaveProperty("OTHER_AGENT_API_KEY");
    }
  });

  it("errors when the credential is missing", () => {
    const r = resolveAgentRunEnv({
      authMode: "subscription",
      credentialValue: null,
      baseEnv: {},
      ...CLAUDE_CODE_VARS,
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
