# Architecture Overview

**Status:** Draft · **Owner:** Architecture · **Last reviewed:** 2026-08-17

This section documents SoloW's architecture at a business-readable altitude, using
the [arc42](https://arc42.org) template for structure and the [C4 model](https://c4model.com)
for describing system views. It contains no source code; it explains how the system is
shaped and why, and links to the [Decision Log](../decisions/README.md) for the reasoning
behind each significant choice.

## arc42 sections

| # | Section | Answers |
|---|---------|---------|
| [01](./01-introduction-and-goals.md) | Introduction & Goals | What the system must achieve and for whom |
| [02](./02-constraints.md) | Constraints | The fixed conditions the architecture must respect |
| [03](./03-context-and-scope.md) | Context & Scope | The system's boundary and its neighbours (C4 System Context) |
| [04](./04-solution-strategy.md) | Solution Strategy | The core approach and the big choices |
| [05](./05-building-blocks.md) | Building Blocks | The major parts and their responsibilities (C4 Container / Component) |
| [06](./06-runtime-scenarios.md) | Runtime Scenarios | How the parts collaborate for key journeys |
| [07](./07-deployment-view.md) | Deployment View | How the system runs locally and hosted |
| [08](./08-crosscutting-concepts.md) | Cross-cutting Concepts | Concerns that span the whole system |
| [09](./09-quality-requirements.md) | Quality Requirements | The quality goals and how they are judged |
| [10](./10-risks-and-technical-debt.md) | Risks & Technical Debt | Known risks and areas to watch |

## The one-paragraph shape

SoloW is a control plane. A person interacts with an application that presents Boards,
Issues, Workflows, and a review workspace. Behind it, a long-lived orchestration component
launches and supervises external AI coding agents through a standard protocol, each in an
isolated working copy inside a chosen execution environment, and streams their activity back
to the person for review. A durable orchestration engine ensures multi-step Workflows and
Tasks survive interruptions and pause cleanly for human decisions. State is stored so that
everything can be reconstructed, and the whole system runs the same way on one machine or as
a shared service.
