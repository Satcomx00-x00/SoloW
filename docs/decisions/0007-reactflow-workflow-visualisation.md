# 0007 — Visualise Workflows as an interactive node graph (ReactFlow)

**Status:** Accepted · **Date:** 2026-08-17 · **Deciders:** Product, Design

## Context

Workflows chain multiple agents and human decisions into multi-step processes. These
processes are hard to understand and steer when represented as lists or logs. Users need to
both **design** a Workflow and **watch a live Run** in a way that makes branching, parallel
steps, and human gates immediately legible.

## Decision

Represent Workflows as an **interactive node graph**, using **ReactFlow** as the
visualisation surface. Steps are nodes; transitions are directed edges. The same graph is
used for design and for live monitoring, with each Step's status overlaid on the graph during
a Run.

## Considered options

- **List or table of steps** — Rejected: cannot express branching, parallelism, or gates
  legibly; poor for live monitoring.
- **Static generated diagram** — Rejected: not editable in place; disconnected from the live
  Run.
- **Interactive node-graph canvas (chosen)** — supports both design and live monitoring in one
  understandable surface, and scales to large Workflows with panning and zooming.

## Consequences

- Positive: complex, multi-agent processes are understandable at a glance and steerable in
  real time; design and monitoring share one mental model.
- Positive: aligns with the product principle that Workflows are visual and repeatable.
- Negative: large graphs require careful layout and navigation to stay legible (risk noted in
  [F03](../features/F03-workflow-designer.md) NFR-2).
- Realises [F03](../features/F03-workflow-designer.md).
