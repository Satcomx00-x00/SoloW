/// <reference types="bun-types" />
import { type FakeAgentScript, serveFakeAgentOverStdio } from "../testing.js";

/**
 * Runnable fake ACP agent — the "agent CLI" the process-transport test spawns. The script is
 * passed as a JSON argument so one fixture covers every scenario. It deliberately never exits
 * on its own: the test asserts that stopping the agent terminates the process (TASK-014).
 */
const script: FakeAgentScript = process.argv[2] ? JSON.parse(process.argv[2]) : {};
await serveFakeAgentOverStdio(script);
