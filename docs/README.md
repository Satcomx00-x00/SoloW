# SoloW — Documentation

SoloW is an open-source, self-hostable platform for running AI coding-harness CLIs in
parallel on your own machine, with a review-first workflow. Two harnesses come ready to use,
Claude Code and opencode; any other must be added by hand
([F04](./features/F04-harness-orchestration.md)). SoloW 1.0 is built for one person, the solo
power user ([0031](./decisions/0031-focus-on-the-solo-power-user.md)); hosted team use is
Later.

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
| [`operations/`](./operations/) | How-to guides | Running a local install day to day: [backup and restore](./operations/backup-and-restore.md), [running as a service](./operations/running-as-a-service.md) |
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
