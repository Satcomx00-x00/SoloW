/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import type { TaskRepositoryDto } from "@solow/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { DeliveryStatus } from "./delivery-status";

afterEach(cleanup);

const attachment = (over: Partial<TaskRepositoryDto> = {}): TaskRepositoryDto => ({
  id: "att-1",
  repositoryId: "repo-1",
  baseRef: "main",
  checkoutBranch: "solow/task-1",
  resultBranch: null,
  position: 0,
  ...over,
});

describe("DeliveryStatus", () => {
  it("links to the pull request once approval opened one", () => {
    render(
      <DeliveryStatus
        attachment={attachment({
          resultBranch: "solow/task-1",
          changeRequestUrl: "https://forge.example/acme/gate/pull/7",
          changeRequestNumber: 7,
        })}
      />,
    );
    const link = screen.getByRole("link", { name: /Pull request #7/ });
    expect(link.getAttribute("href")).toBe("https://forge.example/acme/gate/pull/7");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("says plainly that a branch with no pull request was only committed locally", () => {
    render(<DeliveryStatus attachment={attachment({ resultBranch: "solow/task-1" })} />);
    expect(screen.getByText(/Committed locally — not pushed/)).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("shows nothing before approval", () => {
    const { container } = render(<DeliveryStatus attachment={attachment()} />);
    expect(container.textContent).toBe("");
  });

  it("refuses to render a non-http address as a link", () => {
    render(
      <DeliveryStatus
        attachment={attachment({
          resultBranch: "solow/task-1",
          changeRequestUrl: "javascript:alert(1)",
        })}
      />,
    );
    expect(screen.queryByRole("link")).toBeNull();
  });
});
