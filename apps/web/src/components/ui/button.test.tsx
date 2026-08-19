/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { Button } from "./button"

/**
 * The button's `loading` state is real behaviour, not styling: a pending review decision that
 * could be clicked twice would record two decisions on one session (Principle I). It is built
 * into the control rather than left to each call site so no call site can forget it.
 */

afterEach(cleanup)

describe("Button loading state", () => {
  it("blocks a second click while the first is in flight", () => {
    let clicks = 0
    render(
      <Button loading onClick={() => clicks++}>
        Approve
      </Button>,
    )
    const button = screen.getByRole("button", { name: "Approve" })

    fireEvent.click(button)
    fireEvent.click(button)

    expect(clicks).toBe(0)
    expect(button.hasAttribute("disabled")).toBe(true)
  })

  it("announces itself as busy rather than only looking busy", () => {
    render(<Button loading>Approve</Button>)
    expect(screen.getByRole("button").getAttribute("aria-busy")).toBe("true")
  })

  it("keeps one accessible name throughout, so the label does not change under the cursor", () => {
    const { rerender } = render(<Button>Save secret</Button>)
    expect(screen.getByRole("button", { name: "Save secret" })).toBeDefined()
    rerender(<Button loading>Save secret</Button>)
    expect(screen.getByRole("button", { name: "Save secret" })).toBeDefined()
  })

  it("shows a spinner while loading and none when idle", () => {
    const { rerender } = render(<Button loading>Approve</Button>)
    expect(screen.getByRole("button").querySelector(".animate-spin")).not.toBeNull()
    rerender(<Button>Approve</Button>)
    expect(screen.getByRole("button").querySelector(".animate-spin")).toBeNull()
  })

  it("clicks normally when idle", () => {
    let clicks = 0
    render(<Button onClick={() => clicks++}>Approve</Button>)
    fireEvent.click(screen.getByRole("button"))
    expect(clicks).toBe(1)
  })

  it("stays disabled when disabled for its own reasons, loading or not", () => {
    render(
      <Button disabled>
        Add profile
      </Button>,
    )
    expect(screen.getByRole("button").hasAttribute("disabled")).toBe(true)
  })

  it("does not inject a spinner into an asChild trigger, whose child owns its rendering", () => {
    // `asChild` renders the caller's element; adding our own children would nest a second node
    // inside it and Radix's Slot would throw on multiple children.
    render(
      <Button asChild>
        <a href="/board">Back to board</a>
      </Button>,
    )
    const link = screen.getByRole("link", { name: "Back to board" })
    expect(link.querySelector(".animate-spin")).toBeNull()
    expect(link.textContent).toBe("Back to board")
  })
})

describe("Button sizing", () => {
  it("puts every size on the shared 4px control ladder", () => {
    // Buttons, inputs and selects all sit on these heights; drifting off it is what makes a
    // toolbar look assembled from parts.
    for (const [size, height] of [
      ["xs", "h-6"],
      ["sm", "h-7"],
      ["default", "h-8"],
      ["lg", "h-9"],
    ] as const) {
      cleanup()
      render(<Button size={size}>Go</Button>)
      expect(screen.getByRole("button").className).toContain(height)
    }
  })
})
