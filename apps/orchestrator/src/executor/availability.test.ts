import { describe, expect, it } from "bun:test";
import { probeDockerAvailability } from "./availability.js";
import type { Executor } from "./types.js";

const host = (exec: Executor["exec"]) => ({ exec }) as unknown as Executor;

describe("probeDockerAvailability", () => {
  it("is available when the daemon answers with a server version", async () => {
    const report = await probeDockerAvailability(
      host(async () => ({ exitCode: 0, stdout: "29.7.2\n", stderr: "" })),
      "docker",
    );
    expect(report).toEqual({ available: true, reason: null });
  });

  it("says why when the CLI is there but the daemon is not", async () => {
    const report = await probeDockerAvailability(
      host(async () => ({
        exitCode: 1,
        stdout: "",
        stderr: "Cannot connect to the Docker daemon\nmore",
      })),
      "docker",
    );
    expect(report).toEqual({ available: false, reason: "Cannot connect to the Docker daemon" });
  });

  it("treats a missing binary, which rejects rather than exiting 127, as unavailable", async () => {
    const report = await probeDockerAvailability(
      host(async () => {
        throw new Error("ENOENT: docker");
      }),
      "docker",
    );
    expect(report.available).toBe(false);
    expect(report.reason).toContain("ENOENT");
  });
});
