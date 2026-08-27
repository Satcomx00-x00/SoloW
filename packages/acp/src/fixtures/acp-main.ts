/// <reference types="bun-types" />
import { type AcpScript, serveScriptedAcpAgent } from "../testing.js";

/**
 * Runnable fake ACP agent. The script arrives as a JSON argument so one fixture covers every
 * scenario, and any arguments the catalog row adds are simply ignored — the point of the test
 * is what SoloW does with the protocol, not that the fake parses flags.
 */
const scriptArg = process.argv.find((arg) => arg.startsWith("{")) ?? "{}";
const script: AcpScript = JSON.parse(scriptArg);
await serveScriptedAcpAgent(script);
