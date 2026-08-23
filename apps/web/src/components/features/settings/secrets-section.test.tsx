/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithTrpc } from "@/test/trpc-harness";

/**
 * Settings form tests (task TASK-024; extended for spec AC-013 / issue #63's `?renewSecret=`
 * deep link). The Secrets form is the one place a credential is typed, so these assert the
 * write-only contract from the UI side (Principle IV): the value is sent once, is never
 * rendered back, and the submit button is disabled while the write is in flight.
 *
 * `next/navigation` is stubbed locally rather than inherited from whichever other test file's
 * `mock.module` happened to run first in this process — `SecretsSection` now reads
 * `useSearchParams`, and issue-detail.test.tsx already documents why a shared, partial stub is a
 * leak waiting to break the next consumer. `searchParams` is a `let` so individual tests can set
 * `?renewSecret=` before rendering.
 */
let searchParams = new URLSearchParams();
mock.module("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  usePathname: () => "/settings",
  useSearchParams: () => searchParams,
  useParams: () => ({}),
}));

const { SecretsSection } = await import("./secrets-section");

beforeEach(() => {
  searchParams = new URLSearchParams();
});

afterEach(cleanup);

const SECRET_VALUE = "sk-ant-do-not-render-me";

describe("SecretsSection", () => {
  it("submits the typed value once and never renders it back", async () => {
    let resolveSet: (v: unknown) => void = () => {};
    const stored: Array<{ id: string; name: string; kind: string; usedBy: never[] }> = [];

    const { log, container } = renderWithTrpc(<SecretsSection />, {
      "secret.list": () => stored,
      "secret.set": (input) =>
        new Promise((resolve) => {
          resolveSet = () => {
            const i = input as { name: string; kind: string };
            // The server answers with metadata only — no value field exists in the response.
            const ref = { id: "secret-1", name: i.name, kind: i.kind, usedBy: [] };
            stored.push(ref);
            resolve({ secret: ref, resumedTaskCount: 0 });
          };
        }),
    });

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "anthropic-api-key" } });
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: SECRET_VALUE } });
    fireEvent.submit(screen.getByRole("button", { name: "Save secret" }).closest("form")!);

    // In flight: submit is disabled so a double-click cannot write the secret twice.
    await waitFor(() => {
      const submit = screen.getByRole("button", { name: "Save secret" });
      expect(submit.hasAttribute("disabled")).toBe(true);
      expect(submit.getAttribute("aria-busy")).toBe("true");
    });

    resolveSet(undefined);

    await waitFor(() => {
      expect(screen.getByText("anthropic-api-key")).toBeDefined();
    });
    const writes = log.calls.filter((c) => c.path === "secret.set");
    expect(writes).toHaveLength(1);
    expect((writes[0]?.input as { value: string } | undefined)?.value).toBe(SECRET_VALUE);
    // The value reached the server exactly once and appears nowhere in the rendered DOM.
    expect(container.innerHTML).not.toContain(SECRET_VALUE);
  });

  it("clears the value field after a successful write", async () => {
    renderWithTrpc(<SecretsSection />, {
      "secret.list": () => [],
      "secret.set": (input) => ({
        secret: { id: "s1", usedBy: [], ...(input as { name: string; kind: string }) },
        resumedTaskCount: 0,
      }),
    });

    const value = screen.getByLabelText("Value") as HTMLInputElement;
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "token" } });
    fireEvent.change(value, { target: { value: SECRET_VALUE } });
    fireEvent.submit(screen.getByRole("button", { name: "Save secret" }).closest("form")!);

    await waitFor(() => expect(value.value).toBe(""));
    // A password input is used so the value is not shoulder-readable while being typed.
    expect(value.getAttribute("type")).toBe("password");
  });

  it("deletes a Secret only after the Owner confirms it", async () => {
    const deleted: unknown[] = [];
    renderWithTrpc(<SecretsSection />, {
      "secret.list": () => [{ id: "s1", name: "spare-token", kind: "api_key", usedBy: [] }],
      "secret.delete": (input) => {
        deleted.push(input);
        return { id: "s1", name: "spare-token", kind: "api_key", usedBy: [] };
      },
    });

    const trigger = await screen.findByRole("button", { name: "Delete the secret spare-token" });
    fireEvent.click(trigger);

    // Opening the confirmation must not be the delete: a stored credential cannot be re-read,
    // so a stray click on a ghost icon button would be unrecoverable (spec F17 FR-6).
    expect(deleted).toHaveLength(0);

    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete secret" }));

    await waitFor(() => expect(deleted).toEqual([{ id: "s1" }]));
  });

  it("refuses to offer deletion for a Secret something still holds, and says what holds it", async () => {
    renderWithTrpc(<SecretsSection />, {
      "secret.list": () => [
        {
          id: "s1",
          name: "github-pat",
          kind: "scm_pat",
          usedBy: [{ holder: "integration", name: "github" }],
        },
      ],
    });

    const trigger = await screen.findByRole("button", { name: "Delete the secret github-pat" });
    expect(trigger.hasAttribute("disabled")).toBe(true);
    // The disabled button is only fair if the row says why.
    expect(screen.getByText("Used by github")).toBeDefined();
  });

  it("surfaces a write failure to the Owner instead of failing silently", async () => {
    renderWithTrpc(<SecretsSection />, {
      "secret.list": () => [],
      "secret.set": () => {
        throw new Error("rate_limited");
      },
    });

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "token" } });
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: SECRET_VALUE } });
    fireEvent.submit(screen.getByRole("button", { name: "Save secret" }).closest("form")!);

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("rate_limited");
    });
  });

  it("pre-fills the name and kind from `?renewSecret=`, and focuses the value field (spec AC-013)", async () => {
    // Renewing a credential is the recovery path off a credential-expired Task card — the form
    // must already know which Secret it is about without the Owner retyping its name.
    //
    // The fixture kind is deliberately NOT the field's own default ("api_key") — a prefill that
    // happens to match the default would pass this assertion whether or not the effect that sets
    // it ever ran, which is exactly how a real bug here (the Select showing blank instead of the
    // prefilled kind after a client-side navigation — a Radix mount-timing issue, see the
    // component's comment) went unnoticed.
    searchParams = new URLSearchParams("renewSecret=anthropic-subscription");
    renderWithTrpc(<SecretsSection />, {
      "secret.list": () => [
        { id: "s1", name: "anthropic-subscription", kind: "subscription_token", usedBy: [] },
      ],
    });

    await waitFor(() => {
      expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
        "anthropic-subscription",
      );
    });
    // The visible label, not just the underlying value — the bug this guards against left the
    // state correct while the trigger's text stayed blank.
    await waitFor(() => {
      expect(screen.getByLabelText("Kind").textContent).toContain("Subscription token");
    });
    expect(document.activeElement).toBe(screen.getByLabelText("Value"));
  });

  it("does not touch the form when there is nothing to renew", async () => {
    renderWithTrpc(<SecretsSection />, { "secret.list": () => [] });
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("");
    expect(document.activeElement).not.toBe(screen.getByLabelText("Value"));
  });

  it("resuming Tasks after a renewal is reported to the Owner", async () => {
    renderWithTrpc(<SecretsSection />, {
      "secret.list": () => [],
      "secret.set": (input) => ({
        secret: { id: "s1", usedBy: [], ...(input as { name: string; kind: string }) },
        resumedTaskCount: 2,
      }),
    });

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "anthropic-api-key" } });
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: SECRET_VALUE } });
    fireEvent.submit(screen.getByRole("button", { name: "Save secret" }).closest("form")!);

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain("2 tasks");
    });
  });

  it("says nothing when the renewal did not unblock any Task — the common case", async () => {
    renderWithTrpc(<SecretsSection />, {
      "secret.list": () => [],
      "secret.set": (input) => ({
        secret: { id: "s1", usedBy: [], ...(input as { name: string; kind: string }) },
        resumedTaskCount: 0,
      }),
    });

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "brand-new" } });
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: SECRET_VALUE } });
    fireEvent.submit(screen.getByRole("button", { name: "Save secret" }).closest("form")!);

    await waitFor(() =>
      expect((screen.getByLabelText("Value") as HTMLInputElement).value).toBe(""),
    );
    expect(screen.queryByRole("status")).toBeNull();
  });
});
