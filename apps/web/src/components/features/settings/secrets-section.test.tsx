/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithTrpc } from "@/test/trpc-harness";
import { SecretsSection } from "./secrets-section";

/**
 * Settings form tests (task TASK-024). The Secrets form is the one place a credential is typed,
 * so these assert the write-only contract from the UI side (Principle IV): the value is sent
 * once, is never rendered back, and the submit button is disabled while the write is in flight.
 */

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
            resolve(ref);
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
        id: "s1",
        usedBy: [],
        ...(input as { name: string; kind: string }),
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
});
