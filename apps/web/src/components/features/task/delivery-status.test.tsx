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

const github = { source: "remote_url" as const, changeRequestNoun: "pull request" };
const gitlab = { source: "remote_url" as const, changeRequestNoun: "merge request" };
const localFolder = { source: "local_path" as const, changeRequestNoun: null };
const committed = attachment({ resultBranch: "solow/task-1" });

describe("DeliveryStatus", () => {
  it("links to the pull request once approval opened one", () => {
    render(
      <DeliveryStatus
        repository={github}
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

  it("calls a GitLab request a merge request", () => {
    render(
      <DeliveryStatus
        repository={gitlab}
        attachment={attachment({
          resultBranch: "solow/task-1",
          changeRequestUrl: "https://gitlab.example/acme/gate/-/merge_requests/3",
          changeRequestNumber: 3,
        })}
      />,
    );
    expect(screen.getByRole("link", { name: /Merge request #3/ })).toBeTruthy();
    expect(screen.queryByText(/Pull request/)).toBeNull();
  });

  it("says plainly that a branch in a folder with no remote was only committed locally", () => {
    render(<DeliveryStatus repository={localFolder} attachment={committed} />);
    expect(screen.getByText(/Committed locally — not pushed \(no remote\)/)).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("does not say 'no remote' for a remote repository whose shipping failed", () => {
    render(<DeliveryStatus repository={github} attachment={committed} unshipped />);
    expect(screen.queryByText(/no remote/)).toBeNull();
    expect(screen.getByText(/Not shipped/)).toBeTruthy();
  });

  it("does not say 'no remote' for a remote repository approved before shipping existed", () => {
    render(<DeliveryStatus repository={github} attachment={committed} />);
    expect(screen.queryByText(/no remote/)).toBeNull();
    expect(screen.getByText(/not pushed/)).toBeTruthy();
  });

  it("claims nothing about a remote while the repository is not known", () => {
    render(<DeliveryStatus repository={undefined} attachment={committed} />);
    expect(screen.queryByText(/no remote/)).toBeNull();
    expect(screen.getByText(/not pushed/)).toBeTruthy();
  });

  it("shows nothing before approval", () => {
    const { container } = render(<DeliveryStatus repository={github} attachment={attachment()} />);
    expect(container.textContent).toBe("");
  });

  it("refuses to render a non-http address as a link", () => {
    render(
      <DeliveryStatus
        repository={github}
        attachment={attachment({
          resultBranch: "solow/task-1",
          changeRequestUrl: "javascript:alert(1)",
        })}
      />,
    );
    expect(screen.queryByRole("link")).toBeNull();
  });
});
