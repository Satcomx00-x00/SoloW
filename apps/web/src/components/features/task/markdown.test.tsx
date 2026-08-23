/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { AgentMarkdown } from "./markdown";

/**
 * Most of these are security tests, because that is what this component is for. Agent output is
 * text written by a model that just read a repository and a web page, so every assertion below
 * is a thing a turn could try on the reviewer reading it.
 */

afterEach(cleanup);

describe("AgentMarkdown", () => {
  it("renders a fenced block as code, in its own scroll box", () => {
    const { container } = render(
      <AgentMarkdown text={"Here:\n\n```ts\nconst latch = openLatch();\n```"} />,
    );

    const block = container.querySelector("pre > code");
    expect(block).not.toBeNull();
    expect(block?.textContent).toContain("const latch = openLatch();");
    // The patch, not the page, is what scrolls sideways.
    expect(container.querySelector("pre")?.className).toContain("overflow-x-auto");
  });

  it("renders a GFM table as a table", () => {
    const { container } = render(
      <AgentMarkdown
        text={["| file | status |", "| --- | --- |", "| latch.ts | modified |"].join("\n")}
      />,
    );

    const table = container.querySelector("table");
    expect(table).not.toBeNull();
    expect(table?.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(screen.getByText("latch.ts")).toBeDefined();
    // A wide table scrolls inside its own wrapper rather than widening the transcript column.
    expect(table?.parentElement?.className).toContain("overflow-x-auto");
  });

  it("shows raw HTML in a turn as text, and never as an element", () => {
    // The whole reason `rehype-raw` is not installed. If this ever fails, an agent that read a
    // poisoned README can fire an `onerror` in the reviewer's session.
    const { container } = render(<AgentMarkdown text={'<img src=x onerror="alert(1)">'} />);

    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
  });

  it("refuses a javascript: link, keeping its label as plain text", () => {
    const { container } = render(
      <AgentMarkdown text="[approve the change](javascript:alert(1))" />,
    );

    expect(container.querySelector("a")).toBeNull();
    // The reviewer still sees that a link was attempted — silence would hide the attempt.
    expect(container.textContent).toContain("approve the change");
  });

  it("refuses a data: link too", () => {
    const { container } = render(
      <AgentMarkdown text="[report](data:text/html;base64,PHNjcmlwdD4=)" />,
    );

    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("report");
  });

  it("opens a real link in a new tab, severed from this one", () => {
    const { container } = render(<AgentMarkdown text="see [issue 7](https://example.com/7)" />);

    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://example.com/7");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("does not load an image an agent points at", () => {
    // A markdown image is an outbound request chosen by the agent — a read receipt for the
    // transcript. The alt text stands in for it.
    const { container } = render(
      <AgentMarkdown text="![the failing run](https://tracker.example/pixel.png)" />,
    );

    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("the failing run");
  });

  it("does not lose the text after an unterminated fence", () => {
    // A turn that is still streaming, or a model that forgot the closing fence. Markdown runs
    // the block to the end of the input either way, so the guarantee is that the trailing text
    // is still *readable* — it must never be swallowed into nothing.
    const { container } = render(
      <AgentMarkdown text={"```ts\nconst latch = 1;\n\nthen I fixed the gate"} />,
    );

    expect(container.textContent).toContain("then I fixed the gate");
  });

  it("keeps an unterminated fence inside its own row", () => {
    // The other half of the same guarantee, and the reason `transcript.ts` coalesces a turn
    // before it is rendered: each block is parsed on its own, so a fence one agent left open
    // cannot reach forward into the next row of the transcript.
    const { container } = render(
      <div>
        <AgentMarkdown text={"```ts\nconst latch = 1;"} />
        <AgentMarkdown text="the gate is closed" />
      </div>,
    );

    const rows = container.querySelectorAll(":scope > div > div");
    expect(rows).toHaveLength(2);
    expect(rows[1]?.querySelector("pre")).toBeNull();
    expect(rows[1]?.querySelector("p")?.textContent).toBe("the gate is closed");
  });

  it("renders plain prose as plain prose", () => {
    // The common case, and the one that has to stay cheap and boring: no markdown in the turn
    // means no markup on the page.
    const { container } = render(
      <AgentMarkdown text="Fixed the latch and re-ran the suite. Everything passes." />,
    );

    expect(container.querySelectorAll("p")).toHaveLength(1);
    expect(container.querySelector("p")?.textContent).toBe(
      "Fixed the latch and re-ran the suite. Everything passes.",
    );
    expect(container.querySelector("pre")).toBeNull();
    expect(container.querySelector("code")).toBeNull();
  });
});

/**
 * Syntax colouring. The colours themselves are CSS, so what is testable here is the part that
 * decides them: that a fenced block is tokenised at all, that its language reaches the markup,
 * and that inline code and the no-raw-HTML rule are unchanged by the plugin that does it.
 */
describe("code blocks", () => {
  it("tokenises a fenced block into highlight.js classes", () => {
    const { container } = render(
      <AgentMarkdown text={"```python\nimport pandas as pd  # a comment\n```"} />,
    );
    const code = container.querySelector("pre code");
    expect(code?.className).toContain("hljs");
    // The grammar's own classes are what the theme colours; without them there is nothing to see.
    expect(container.querySelector(".hljs-keyword")).toBeTruthy();
    expect(container.querySelector(".hljs-comment")?.textContent).toContain("a comment");
  });

  it("names the language beside the block", () => {
    const { container } = render(<AgentMarkdown text={"```python\nx = 1\n```"} />);
    expect(container.querySelector("pre code")?.className).toContain("language-python");
    // Shown, because which language it is decides how the block should be read — and because the
    // colours are that language's grammar rather than a general opinion about code.
    expect(screen.getByText("python")).toBeTruthy();
  });

  it("colours and labels a fence that named no language, by detection", () => {
    const { container } = render(
      <AgentMarkdown text={"```\nSELECT id FROM task WHERE state = 'running';\n```"} />,
    );
    expect(container.querySelector("pre code")?.className).toContain("hljs");
    // The label is shown even though the language was guessed — a reader who sees the wrong one
    // knows at once why the colours look off, where an unlabelled block just looks broken.
    expect(container.querySelector("pre code")?.className).toMatch(/language-\w+/);
  });

  it("renders a language it does not know as plain text rather than failing the turn", () => {
    const { container } = render(<AgentMarkdown text={"```notalanguage\nsome text\n```"} />);
    expect(container.querySelector("pre")?.textContent).toContain("some text");
  });

  it("leaves inline code alone", () => {
    const { container } = render(<AgentMarkdown text={"use `pip install` for that"} />);
    const inline = container.querySelector("code");
    expect(inline?.className).not.toContain("hljs");
    expect(container.querySelector("pre")).toBeNull();
  });

  it("does not let the highlighter become a way in for markup", () => {
    // The plugin only ever wraps text nodes it produced itself; raw HTML in a fence is still
    // exactly the characters the model typed.
    const { container } = render(
      <AgentMarkdown text={'```html\n<img src=x onerror="alert(1)">\n```'} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("onerror");
  });
});
