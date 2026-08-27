# SoloW — Documentation

SoloW is an open-source, self-hostable platform for orchestrating many AI
coding-agent CLIs (Claude Code, Codex, Gemini CLI, and 25+ others) in parallel,
with a review-first workflow. It is a business-level alternative to
comparable tools in the category.

This documentation is **business-level and implementation-agnostic** — it describes
*what* the product does and *why*, not *how* it is coded. It contains no source code
and no code snippets.

## How this documentation is organised

The documentation follows established, industry-standard frameworks so that each kind
of information has one predictable home:

| Area | Framework | What it answers |
|------|-----------|-----------------|
| [`product/`](./product/) | PRD / Jobs-to-be-Done | Why the product exists, who it serves, what it must do |
| [`features/`](./features/) | Feature Specifications | The complete behaviour of every feature |
| [`architecture/`](./architecture/) | [arc42](https://arc42.org) + [C4](https://c4model.com) | How the system is structured, at business-readable altitude |
| [`decisions/`](./decisions/) | [MADR / Nygard ADRs](https://adr.github.io) | The significant choices and their trade-offs |
| [`glossary.md`](./glossary.md) | Ubiquitous Language | The shared vocabulary used everywhere |
| [`CONVENTIONS.md`](./CONVENTIONS.md) | Docs-as-Code | How this documentation is written and maintained |

## Reading paths

- **New to the product?** Start with [Vision & Scope](./product/01-vision-and-scope.md),
  then the [Feature Index](./features/README.md).
- **Evaluating against comparable tools?** See [Vision & Scope](./product/01-vision-and-scope.md)
  (competitive positioning), the feature status matrix in the
  [Feature Index](./features/README.md), and the row-by-row
  [Feature Comparison](./product/06-feature-comparison.md) for what the
  current build actually implements.
- **Understanding the system shape?** Read the [Architecture overview](./architecture/README.md).
- **Understanding a specific choice?** Browse the [Decision Log](./decisions/README.md).

## Documentation principles

1. **Docs-as-Code** — documentation lives in this repository, is versioned with the
   product, and changes through the same review process as the code it describes.
2. **One topic, one home** — every fact has a single authoritative location; other
   documents link to it rather than restating it.
3. **Diátaxis-aware** — explanation, reference, and how-to material are kept distinct
   so readers find the right register for their need.
4. **Written for humans first** — plain language, defined terms, no unexplained jargon.
