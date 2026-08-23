"use client";

import { isValidElement, memo, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

/**
 * Agent output, rendered as markdown — under the assumption that it is hostile.
 *
 * An agent's turn is markdown in practice (fenced patches, tables of findings, bullet lists),
 * and the terminal showed it as one flat `whitespace-pre-wrap` string, so a reviewer read raw
 * backticks and pipe characters instead of the structure the model was drawing. That is the
 * cosmetic half.
 *
 * The other half is that this text is *untrusted*. It is written by a model that read a
 * repository, a web page and a tool result, any of which can carry an instruction or a payload
 * aimed at whoever is reading the transcript. So three rules hold here and are covered by tests:
 *
 * 1. **No raw HTML, ever.** `react-markdown` escapes it by default and `rehype-raw` is not
 *    installed — an `<img onerror>` in a turn has to arrive at the reviewer as the characters
 *    the model typed, not as a tag the browser runs. This is also why the file has no
 *    `dangerouslySetInnerHTML`; the repo has none anywhere.
 * 2. **Only http(s) links.** `javascript:` and `data:` URLs are rendered as plain text rather
 *    than as an anchor, so a link in a transcript can never be a script the reviewer clicks.
 *    Real links leave the app in a new tab with `rel="noopener noreferrer"`, because the page
 *    they open is chosen by the agent, not by us.
 * 3. **Nothing widens the page.** A 400-column patch line or a table of file paths scrolls
 *    inside its own box; the transcript column never scrolls sideways, which is what makes the
 *    Task page usable next to an editor.
 *
 * Memoized on `text` because a live turn re-renders on every arriving chunk while the settled
 * blocks above it do not change — parsing them again per chunk is the cost `transcript.ts`
 * builds a stable, keyed row list to avoid.
 */

/** Only these reach an `<a>`. Everything else is a string on the page. */
const SAFE_HREF = /^https?:\/\//i;

/**
 * Telling a fenced block from an inline span.
 *
 * Since react-markdown v9 there is no `inline` flag — both arrive as `code`. `rehype-highlight`
 * settles it: it only ever touches `pre > code`, and it marks what it touched with `hljs`. So the
 * class is the discriminator, and it is one this file does not have to infer.
 *
 * The block used to be flattened to a string here and re-emitted, which would now throw away
 * every span the highlighter produced — so the children are kept, and the styling moved to CSS
 * that colours highlight.js's own class names (see `globals.css`).
 */
function isBlockCode(className: string | undefined): boolean {
  return /\bhljs\b|\blanguage-/.test(className ?? "");
}

/** `language-python hljs` → `python`. Empty when the fence named no language. */
function languageOf(className: string | undefined): string {
  return /\blanguage-([\w+#-]+)/.exec(className ?? "")?.[1] ?? "";
}

/** The `code` element a `<pre>` wraps, so the block can read its language off it. */
function codeChild(node: ReactNode): { className?: string } | null {
  const first = Array.isArray(node) ? node[0] : node;
  return isValidElement<{ className?: string }>(first) ? first.props : null;
}

const components: Components = {
  /*
   * Headings compress to two sizes. A turn is a paragraph or two inside a scrolling column, not
   * a document, so an `h1` that behaved like one would shout over the transcript around it.
   */
  h1: ({ children }) => (
    <h1 className="mt-5 font-semibold text-base tracking-tight first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-5 font-semibold text-sm tracking-tight first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => <h3 className="mt-5 font-semibold text-sm first:mt-0">{children}</h3>,
  h4: ({ children }) => (
    <h4 className="mt-4 font-medium text-muted-foreground text-xs uppercase tracking-wider first:mt-0">
      {children}
    </h4>
  ),
  h5: ({ children }) => (
    <h5 className="mt-4 font-medium text-muted-foreground text-xs uppercase tracking-wider first:mt-0">
      {children}
    </h5>
  ),
  h6: ({ children }) => (
    <h6 className="mt-4 font-medium text-muted-foreground text-xs uppercase tracking-wider first:mt-0">
      {children}
    </h6>
  ),

  /*
   * `whitespace-pre-line` because agents hard-wrap. Markdown folds a single newline into a
   * space, which is right for prose and wrong for the numbered plan or the aligned output an
   * agent writes without leaving two trailing spaces on every line.
   */
  p: ({ children }) => <p className="whitespace-pre-line break-words">{children}</p>,

  ul: ({ children }) => (
    <ul className="ml-1 list-disc space-y-1.5 pl-5 marker:text-muted-foreground/60">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="ml-1 list-decimal space-y-1.5 pl-6 marker:text-muted-foreground/60">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="break-words">{children}</li>,

  a: ({ href, children }) => {
    // A refused scheme still shows its label: dropping the text would hide from the reviewer
    // that the agent tried to link them somewhere, which is exactly what they want to know.
    if (!href || !SAFE_HREF.test(href.trim())) return <>{children}</>;
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
      >
        {children}
      </a>
    );
  },

  code: ({ className, children }) =>
    isBlockCode(className) ? (
      // Inside a block: pass the highlighter's own classes straight through, since the colours
      // are attached to them. No padding or border here — the `pre` around it owns the frame.
      <code className={cn("font-mono", className)}>{children}</code>
    ) : (
      <code className="rounded border bg-background/60 px-1.5 py-0.5 font-mono text-xs">
        {children}
      </code>
    ),

  /*
   * A fenced block, framed, with its language named in the corner.
   *
   * The label is not decoration: an agent's turn can hold a patch, a shell session and a JSON
   * payload one after another, and which one you are looking at decides how you read it. It also
   * reports what the colours mean — they are highlight.js's grammar for *that* language.
   *
   * A fence that named no language still gets one here, because `detect` is on and detection
   * writes the same `language-` class. That is a guess, and labelling it is the point: a reader
   * who sees `SQL` over something that is not SQL knows immediately why the colours look wrong,
   * where an unlabelled block would just look badly highlighted.
   */
  pre: ({ children }) => {
    const language = languageOf(codeChild(children)?.className);
    return (
      <div className="relative min-w-0">
        {language && (
          <span className="absolute top-1.5 right-2 select-none font-mono text-[10px] text-muted-foreground/60 uppercase tracking-wider">
            {language}
          </span>
        )}
        {/* Room for the label, so a long first line runs under nothing. */}
        <pre
          className={cn(
            "overflow-x-auto rounded-lg border bg-background/60 p-3 font-mono text-xs leading-[1.7]",
            language && "pr-16",
          )}
        >
          {children}
        </pre>
      </div>
    );
  },

  blockquote: ({ children }) => (
    <blockquote className="border-l-2 py-0.5 pl-4 text-muted-foreground italic">
      {children}
    </blockquote>
  ),

  /*
   * The scroll box belongs to the table, not to the transcript. A findings table with eight
   * columns is wider than the column it lives in, and the alternative — letting it push the
   * layout — moves every other row on the page.
   */
  table: ({ children }) => (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-muted/50 text-left">{children}</thead>,
  tr: ({ children }) => <tr className="border-b last:border-b-0">{children}</tr>,
  th: ({ children }) => (
    <th className="px-3 py-1.5 text-left align-top font-medium break-words">{children}</th>
  ),
  td: ({ children }) => <td className="px-3 py-1.5 align-top break-words">{children}</td>,

  hr: () => <hr className="my-5 border-t" />,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,

  /*
   * An image is a request. `![](https://attacker/pixel)` in a turn would have the reviewer's
   * browser fetch a URL the agent chose the moment the row mounts — a beacon that says which
   * transcript was read and when. The alt text is shown instead; nothing is loaded.
   */
  img: ({ alt, src }) => (
    <span className="text-muted-foreground text-xs">[image: {alt || String(src ?? "")}]</span>
  ),
};

export const AgentMarkdown = memo(function AgentMarkdown({ text }: { text: string }) {
  return (
    <div className="min-w-0 space-y-3 break-words text-sm leading-[1.75]">
      {/* `urlTransform` is left at its default on purpose: it strips dangerous URLs before the
          `a` component ever sees one, so the allowlist above is the second lock, not the only. */}
      <Markdown
        remarkPlugins={[remarkGfm]}
        /*
         * `rehype-highlight` tokenises the text of a fenced block into spans. It never introduces
         * markup from the source — it only wraps text nodes it produced itself — so it does not
         * widen the "no raw HTML" rule above; `rehype-raw` is still absent and still must be.
         *
         * `detect` is on so a fence with no language still gets coloured, and `ignoreMissing` so
         * a fence naming a language this build did not register renders as plain text in the box
         * rather than throwing inside the parser and taking the whole turn's render with it.
         */
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={components}
      >
        {text}
      </Markdown>
    </div>
  );
});
