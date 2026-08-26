/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithTrpc } from "@/test/trpc-harness";
import { ProviderIdentitySection } from "./provider-identity-section";

/**
 * Stating who you are on a provider (spec F23 FR-11) — the mapping `assignee:@me` resolves
 * through.
 *
 * The claims worth pinning are the ones that decide whether the `My items` tab can work at all:
 * a connection with no mapping has to *say* what that costs rather than looking finished, the
 * login is sent for the Integration it was typed under, and a correction goes through the same
 * upsert rather than accumulating.
 */

afterEach(cleanup);

const TIMESTAMPS = { createdAt: "2026-08-25T00:00:00.000Z", updatedAt: "2026-08-25T00:00:00.000Z" };

const PUBLIC_HOST = {
  id: "int-1",
  provider: "github",
  secretId: "sec-1",
  baseUrl: null,
  writeBackEnabled: false,
  ...TIMESTAMPS,
};

const OWN_HOST = {
  id: "int-2",
  provider: "gitlab",
  secretId: "sec-2",
  baseUrl: "https://code.acme.internal",
  writeBackEnabled: false,
  ...TIMESTAMPS,
};

describe("ProviderIdentitySection", () => {
  it("says what an unstated mapping costs, instead of showing an empty field with no consequence", async () => {
    // The failure this whole section exists for is a silent one: a `My items` tab that matches
    // nothing looks exactly like a project with nothing assigned to you.
    renderWithTrpc(<ProviderIdentitySection />, {
      "integration.list": () => [PUBLIC_HOST],
      "identity.list": () => [],
    });

    expect(await screen.findByText(/matches no/)).toBeDefined();
  });

  it("shows the login already stated for a connection", async () => {
    renderWithTrpc(<ProviderIdentitySection />, {
      "integration.list": () => [PUBLIC_HOST],
      "identity.list": () => [
        { integrationId: "int-1", provider: "github", login: "ada-on-the-host", ...TIMESTAMPS },
      ],
    });

    const input = (await screen.findByLabelText("Your login on github")) as HTMLInputElement;
    expect(input.value).toBe("ada-on-the-host");
    expect(screen.queryByText(/matches no/)).toBeNull();
  });

  it("sends the login for the Integration it was typed under", async () => {
    // One person is two logins when two hosts are connected, which is why the mapping is per
    // Integration — sending it against the wrong one would map the wrong host.
    const { log } = renderWithTrpc(<ProviderIdentitySection />, {
      "integration.list": () => [PUBLIC_HOST, OWN_HOST],
      "identity.list": () => [],
      "identity.set": (input) => ({ ...(input as object), provider: "gitlab", ...TIMESTAMPS }),
    });

    fireEvent.change(await screen.findByLabelText("Your login on gitlab"), {
      target: { value: "ada-internal" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[1] as HTMLElement);

    await waitFor(() => {
      const writes = log.calls.filter((c) => c.path === "identity.set");
      expect(writes).toHaveLength(1);
      expect(writes[0]?.input).toEqual({ integrationId: "int-2", login: "ada-internal" });
    });
  });

  it("trims a pasted login rather than storing the space with it", async () => {
    // A login pasted from a profile page arrives with whitespace, and a stored " ada" would
    // resolve `@me` to a name the provider has never reported.
    const { log } = renderWithTrpc(<ProviderIdentitySection />, {
      "integration.list": () => [PUBLIC_HOST],
      "identity.list": () => [],
      "identity.set": (input) => ({ ...(input as object), provider: "github", ...TIMESTAMPS }),
    });

    fireEvent.change(await screen.findByLabelText("Your login on github"), {
      target: { value: "  ada-on-the-host " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const writes = log.calls.filter((c) => c.path === "identity.set");
      expect(writes[0]?.input).toEqual({ integrationId: "int-1", login: "ada-on-the-host" });
    });
  });

  it("offers to forget a stated mapping, and asks the server to clear rather than to store empty", async () => {
    // "Not stated" and "stated as nothing" have to stay one state — see the DAL for why.
    const { log } = renderWithTrpc(<ProviderIdentitySection />, {
      "integration.list": () => [PUBLIC_HOST],
      "identity.list": () => [
        { integrationId: "int-1", provider: "github", login: "ada-on-the-host", ...TIMESTAMPS },
      ],
      "identity.clear": (input) => input as object,
    });

    fireEvent.click(await screen.findByRole("button", { name: "Forget" }));

    await waitFor(() => {
      const writes = log.calls.filter((c) => c.path === "identity.clear");
      expect(writes).toHaveLength(1);
      expect(writes[0]?.input).toEqual({ integrationId: "int-1" });
    });
    expect(log.calls.filter((c) => c.path === "identity.set")).toHaveLength(0);
  });

  it("says there is nothing to map when no Integration is connected", async () => {
    // A bare form for a mapping that cannot exist yet reads as a setting somebody forgot to fill.
    renderWithTrpc(<ProviderIdentitySection />, {
      "integration.list": () => [],
      "identity.list": () => [],
    });

    expect(await screen.findByText(/No integration connected yet/)).toBeDefined();
  });
});
