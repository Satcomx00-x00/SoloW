/// <reference types="bun-types" />
import { type FakeClaudeScript, serveFakeClaude } from "../testing.js";

/**
 * Runnable fake `claude`. The script arrives as a JSON argument so one fixture covers every
 * scenario, and GateControl's own required flags are simply ignored — the point of the test is
 * what GateControl does with the stream, not that the fake understands `--permission-mode`.
 */
const scriptArg = process.argv.find((arg) => arg.startsWith("{")) ?? "{}";
const script: FakeClaudeScript = JSON.parse(scriptArg);
await serveFakeClaude(script);
