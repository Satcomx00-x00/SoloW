/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { AUTO_APPROVE_FLAG, clientDirectives } from "./client-directives.js";

/**
 * A catalog row's arguments, split between the harness process and SoloW as its ACP client.
 * `opencode acp --auto` is refused by opencode itself ("Unrecognized flag: --auto in command
 * opencode acp", verified on 2.0.22 and 2.0.24), so the flag must never reach the process.
 */
describe("clientDirectives", () => {
  it("takes --auto off an ACP harness's command line and turns it into auto-approval", () => {
    expect(clientDirectives("acp", ["acp", "--auto"])).toEqual({
      args: ["acp"],
      autoApprove: true,
    });
  });

  it("leaves an ACP row without --auto exactly as it is", () => {
    expect(clientDirectives("acp", ["acp", "--log-level", "debug"])).toEqual({
      args: ["acp", "--log-level", "debug"],
      autoApprove: false,
    });
  });

  it("hands every other protocol its arguments untouched — its CLI takes its own flags", () => {
    expect(clientDirectives("claude_code_stream_json", ["--auto"])).toEqual({
      args: ["--auto"],
      autoApprove: false,
    });
    expect(clientDirectives("cli_passthrough", ["run", "--auto"])).toEqual({
      args: ["run", "--auto"],
      autoApprove: false,
    });
  });

  it("treats a missing template as no arguments", () => {
    expect(clientDirectives("acp", null)).toEqual({ args: [], autoApprove: false });
    expect(clientDirectives("acp", undefined)).toEqual({ args: [], autoApprove: false });
  });

  it("names the flag opencode documents", () => {
    expect(AUTO_APPROVE_FLAG).toBe("--auto");
  });
});
