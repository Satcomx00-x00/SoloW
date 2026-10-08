import { describe, expect, it } from "bun:test";
import { ORCHESTRATOR_SECRET_MIN_LENGTH, readOrchestratorSecret } from "./orchestrator-secret.js";

describe("readOrchestratorSecret — the one rule both ends of POST /events apply", () => {
  it("is absent when nothing is set", () => {
    expect(readOrchestratorSecret(undefined)).toEqual({ ok: false, problem: "missing" });
    expect(readOrchestratorSecret("")).toEqual({ ok: false, problem: "missing" });
  });

  it("refuses a value too short to be a secret, rather than accepting it on one side only", () => {
    const short = "x".repeat(ORCHESTRATOR_SECRET_MIN_LENGTH - 1);
    expect(readOrchestratorSecret(short)).toEqual({ ok: false, problem: "too_short" });
  });

  it("accepts one of the minimum length or longer", () => {
    const secret = "s".repeat(ORCHESTRATOR_SECRET_MIN_LENGTH);
    expect(readOrchestratorSecret(secret)).toEqual({ ok: true, secret });
  });
});
