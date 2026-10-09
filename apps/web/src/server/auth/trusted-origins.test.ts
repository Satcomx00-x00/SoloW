/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { trustedOriginsFor } from "./trusted-origins.js";

/**
 * The origin list BetterAuth checks a sign-in against. A fresh install was refused at its own
 * address — `SOLOW_WEB_URL` said `localhost`, the browser said `127.0.0.1` — so the claim pinned
 * here is twofold: every loopback spelling of the configured port is accepted, and nothing that
 * is not loopback is ever added.
 */
describe("trustedOriginsFor", () => {
  it("accepts every loopback spelling of a loopback address, on the same scheme and port", () => {
    expect(trustedOriginsFor("http://localhost:5460")).toEqual([
      "http://localhost:5460",
      "http://127.0.0.1:5460",
      "http://[::1]:5460",
    ]);
  });

  it("starts from whichever loopback spelling was configured", () => {
    expect(trustedOriginsFor("http://127.0.0.1:5000")).toEqual([
      "http://127.0.0.1:5000",
      "http://localhost:5000",
      "http://[::1]:5000",
    ]);
    expect(trustedOriginsFor("http://[::1]:5000")[0]).toBe("http://[::1]:5000");
  });

  it("keeps the scheme and an implied port as they are", () => {
    expect(trustedOriginsFor("https://localhost")).toEqual([
      "https://localhost",
      "https://127.0.0.1",
      "https://[::1]",
    ]);
  });

  it("trusts a non-loopback address exactly as written, and nothing else", () => {
    expect(trustedOriginsFor("http://192.0.2.10:5000")).toEqual(["http://192.0.2.10:5000"]);
    expect(trustedOriginsFor("https://solow.example.com")).toEqual(["https://solow.example.com"]);
  });

  it("drops a trailing path, which an Origin header never carries", () => {
    expect(trustedOriginsFor("http://localhost:5000/")[0]).toBe("http://localhost:5000");
  });
});
