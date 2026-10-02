import { describe, expect, test } from "bun:test";
import {
  configHarnessFor,
  createHarnessConfigInput,
  freeCopyName,
  HARNESS_CONFIG_DOCUMENT_KIND,
  harnessConfigDocument,
  harnessConfigViolations,
  toHarnessConfigDocument,
  updateHarnessConfigInput,
} from "./harness-config.js";

describe("configHarnessFor", () => {
  test("stream-json is Claude Code whatever the key", () => {
    expect(configHarnessFor({ protocol: "claude_code_stream_json", key: "x", command: "c" })).toBe(
      "claude_code",
    );
  });
  test("opencode by key or by binary", () => {
    expect(configHarnessFor({ protocol: "acp", key: "opencode", command: "opencode" })).toBe(
      "opencode",
    );
    expect(configHarnessFor({ protocol: "acp", key: "oc2", command: "/opt/bin/opencode" })).toBe(
      "opencode",
    );
  });
  test("an ACP agent SoloW cannot configure has no format", () => {
    expect(configHarnessFor({ protocol: "acp", key: "gemini", command: "gemini" })).toBeNull();
  });
});

describe("harnessConfigViolations", () => {
  test("Claude Code: billing and config-discovery variables, and apiKeyHelper", () => {
    expect(
      harnessConfigViolations("claude_code", {
        env: { ANTHROPIC_API_KEY: "k", HOME: "/root", DEBUG: "1" },
        apiKeyHelper: "/bin/key",
      }),
    ).toEqual([
      "env.ANTHROPIC_API_KEY is owned by SoloW",
      "env.HOME is owned by SoloW",
      "apiKeyHelper would bypass the profile's credential",
    ]);
  });
  test("opencode: an inline provider key", () => {
    expect(
      harnessConfigViolations("opencode", {
        provider: { anthropic: { options: { apiKey: "k" } } },
      }),
    ).toEqual(["provider.anthropic.options.apiKey belongs in the profile's Secret"]);
  });
  test("opencode 2: native providers settings and credential headers", () => {
    expect(
      harnessConfigViolations("opencode", {
        providers: {
          acme: {
            package: "aisdk:@ai-sdk/openai-compatible",
            settings: { baseURL: "https://llm.example.com/v1", apiKey: "k" },
            headers: { Authorization: "Bearer k", "X-Trace": "1" },
          },
        },
      }),
    ).toEqual([
      "providers.acme.settings.apiKey belongs in the profile's Secret",
      "providers.acme.headers.Authorization belongs in the profile's Secret",
    ]);
  });
  test("opencode 2: native permissions and agents pass", () => {
    expect(
      harnessConfigViolations("opencode", {
        permissions: [{ action: "shell", resource: "git push *", effect: "ask" }],
        agents: { reviewer: { system: "Review.", model: "anthropic/claude-sonnet-4-5#high" } },
        providers: { acme: { settings: { baseURL: "https://llm.example.com/v1" } } },
      }),
    ).toEqual([]);
  });
  test("an ordinary config passes", () => {
    expect(harnessConfigViolations("claude_code", { permissions: { allow: [] } })).toEqual([]);
  });
});

describe("inputs", () => {
  test("create names every offending key", () => {
    const r = createHarnessConfigInput.safeParse({
      name: "x",
      harness: "claude_code",
      content: { apiKeyHelper: "k" },
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(["content"]);
  });
  test("update checks content against the restated harness", () => {
    const base = { id: "c", harness: "opencode" as const };
    expect(updateHarnessConfigInput.safeParse({ ...base, name: "n" }).success).toBe(true);
    expect(
      updateHarnessConfigInput.safeParse({
        ...base,
        content: { provider: { p: { options: { apiKey: "k" } } } },
      }).success,
    ).toBe(false);
  });
  test("a non-object root is refused", () => {
    expect(
      createHarnessConfigInput.safeParse({ name: "x", harness: "opencode", content: [] }).success,
    ).toBe(false);
  });
});

describe("documents", () => {
  test("round-trip through the portable form", () => {
    const doc = toHarnessConfigDocument({
      name: "Strict",
      description: null,
      harness: "claude_code",
      content: { model: "opus" },
    });
    expect(doc.kind).toBe(HARNESS_CONFIG_DOCUMENT_KIND);
    expect(harnessConfigDocument.parse(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
  });
  test("an unknown kind is not a harness config", () => {
    expect(
      harnessConfigDocument.safeParse({
        kind: "other",
        version: 1,
        name: "x",
        harness: "opencode",
        content: {},
      }).success,
    ).toBe(false);
  });
});

test("freeCopyName", () => {
  expect(freeCopyName("a", new Set())).toBe("a");
  expect(freeCopyName("a", new Set(["a"]))).toBe("a (copy)");
  expect(freeCopyName("a", new Set(["a", "a (copy)"]))).toBe("a (copy 2)");
});
