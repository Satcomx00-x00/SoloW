import { describe, expect, it } from "bun:test";
import { probeDockerAvailability } from "./availability.js";
import type { ExecResult, Executor } from "./types.js";

const host = (exec: Executor["exec"]) => ({ exec }) as unknown as Executor;

const IMAGE = "solow-executor:local";

/** A daemon that answers `version` with a server, and `image inspect` as told. */
const daemon = (image: (argv: string[]) => Promise<ExecResult>, seen: string[][] = []) =>
  host(async (argv) => {
    seen.push(argv);
    if (argv[1] === "version") return { exitCode: 0, stdout: "29.7.2\n", stderr: "" };
    return image(argv);
  });

describe("probeDockerAvailability", () => {
  it("is available, with the executor image, when the daemon has it", async () => {
    const seen: string[][] = [];
    const report = await probeDockerAvailability(
      daemon(async () => ({ exitCode: 0, stdout: "sha256:abc\n", stderr: "" }), seen),
      "docker",
      IMAGE,
    );
    expect(report).toEqual({
      available: true,
      reason: null,
      executorImage: { name: IMAGE, present: true },
    });
    // Looked up, never pulled: a local tag has no registry behind it.
    expect(seen).toContainEqual(["docker", "image", "inspect", IMAGE, "--format", "{{.Id}}"]);
    expect(seen.some((argv) => argv.includes("pull"))).toBe(false);
  });

  it("is available without the image when the daemon has not got it", async () => {
    const report = await probeDockerAvailability(
      daemon(async () => ({ exitCode: 1, stdout: "", stderr: "Error: No such image" })),
      "docker",
      IMAGE,
    );
    expect(report).toEqual({
      available: true,
      reason: null,
      executorImage: { name: IMAGE, present: false },
    });
  });

  it("reads an image lookup that never answers as absent, not as Docker gone", async () => {
    const report = await probeDockerAvailability(
      daemon(async () => {
        throw new Error("docker did not answer within 5s");
      }),
      "docker",
      IMAGE,
    );
    expect(report.available).toBe(true);
    expect(report.executorImage.present).toBe(false);
  });

  it("says why when the CLI is there but the daemon is not, and asks nothing about the image", async () => {
    const seen: string[][] = [];
    const report = await probeDockerAvailability(
      host(async (argv) => {
        seen.push(argv);
        return { exitCode: 1, stdout: "", stderr: "Cannot connect to the Docker daemon\nmore" };
      }),
      "docker",
      IMAGE,
    );
    expect(report).toEqual({
      available: false,
      reason: "Cannot connect to the Docker daemon",
      executorImage: { name: IMAGE, present: false },
    });
    expect(seen).toHaveLength(1);
  });

  it("treats a missing binary, which rejects rather than exiting 127, as unavailable", async () => {
    const report = await probeDockerAvailability(
      host(async () => {
        throw new Error("ENOENT: docker");
      }),
      "docker",
      IMAGE,
    );
    expect(report.available).toBe(false);
    expect(report.reason).toContain("ENOENT");
    expect(report.executorImage).toEqual({ name: IMAGE, present: false });
  });
});
