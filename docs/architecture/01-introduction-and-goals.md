# 1. Introduction & Goals

**Status:** Draft · **Owner:** Architecture · **Last reviewed:** 2026-08-17

## Purpose

SoloW orchestrates many AI coding harnesses in parallel under human review. This
document introduces the architectural goals that shape the system. The product goals are in
[Vision & Scope](../product/01-vision-and-scope.md); this section captures the
quality-driven goals the architecture must satisfy.

## Top architectural goals

1. **Safe parallelism.** Many harnesses run at once without interfering with each other's files
   or work. Isolation is a structural property, not a convention.
2. **Durable, resumable orchestration.** Long, multi-step processes survive interruptions and
   pause cleanly for human decisions, then resume rather than restart.
3. **Uniform harness integration.** Many different harness tools are driven through one standard
   protocol, so adding a harness does not change the rest of the system.
4. **One product, two deployment modes.** The same system runs locally for one user and
   hosted for a team, differing only in configuration.
5. **Trustworthy handling of money and secrets.** Billing mode is honoured exactly; secrets
   never reach harness-run code; nothing leaves the user's control without an explicit action.

## Key stakeholders and their concerns

| Stakeholder | Primary concern |
|-------------|-----------------|
| Solo Power User | Fast, cheap, local, in-control parallel harness work |
| Team Lead | Standardised, review-gated, shared team use |
| Reviewer | Clear, trustworthy review of harness changes |
| Operator | Safe, reliable, access-controlled hosted operation |

## Relationship to the rest of the documentation

- Product intent: [Vision & Scope](../product/01-vision-and-scope.md), [Product Requirements](../product/03-product-requirements.md).
- Behaviour: the [Feature Specifications](../features/README.md).
- Significant choices: the [Decision Log](../decisions/README.md).
