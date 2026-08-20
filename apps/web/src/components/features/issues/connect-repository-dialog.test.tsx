/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithTrpc } from "@/test/trpc-harness";
import { ConnectRepositoryDialog } from "./connect-repository-dialog";

/**
 * A second, independent entry point to `repository.connect` (user report: adding a repository
 * should also be possible from the backlog, not only from Settings) — same mutation Settings'
 * repositories-section.tsx already uses.
 */

afterEach(cleanup);

describe("ConnectRepositoryDialog", () => {
  it("sends name, source and location to repository.connect", async () => {
    const { log } = renderWithTrpc(
      <ConnectRepositoryDialog trigger={<button type="button">Connect a repository</button>} />,
      { "repository.connect": () => ({ id: "repo-new" }) },
    );

    fireEvent.click(await screen.findByRole("button", { name: "Connect a repository" }));
    fireEvent.change(await screen.findByLabelText("Name"), {
      target: { value: "gate-firmware" },
    });
    fireEvent.change(screen.getByLabelText("Location"), {
      target: { value: "/srv/repos/gate-firmware" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect repository" }));

    await waitFor(() => {
      expect(log.calls.some((c) => c.path === "repository.connect")).toBe(true);
    });
    expect(log.calls.find((c) => c.path === "repository.connect")?.input).toEqual({
      name: "gate-firmware",
      source: "local_path",
      location: "/srv/repos/gate-firmware",
    });
  });
});
