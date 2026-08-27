# F17 — Security & Secrets

**Status:** Draft · **Owner:** Product / Operator · **Maturity:** Core · **Last reviewed:** 2026-08-17

## Summary

SoloW handles sensitive credentials — subscription tokens, API keys, and integration
credentials — and runs untrusted agent activity. This feature defines how those secrets are
protected and how the boundary between agents and credentials is kept safe.

## Jobs served

- **J6 — Control cost.**
- **J10 — Operate with confidence.**

## User stories

- As a user, I want my credentials stored safely and never shown again, so they cannot leak.
- As an Operator, I want to be sure agent-run code cannot read the credentials it uses, so a
  misbehaving agent cannot exfiltrate them.
- As a Team Lead, I want secrets scoped to a Workspace, so they are not shared beyond their
  intended reach.

## Functional requirements

- **FR-1** All secrets (subscription tokens, API keys, integration credentials) are stored
  encrypted at rest.
- **FR-2** A secret is never displayed after it is entered; it can be replaced but not read
  back.
- **FR-3** Secrets are scoped to a Workspace and reused only within it.
- **FR-4** Credentials are supplied to Agents without being exposed to the code an Agent runs
  (product [NFR-7](../product/03-product-requirements.md)).
- **FR-5** For Subscription-mode Agents, SoloW removes any conflicting credential from
  the Agent's run environment so billing cannot be diverted (see [F06](./F06-authentication-billing.md)).
- **FR-6** Destructive actions on secrets (rotation, deletion) require confirmation and are
  recorded.
- **FR-7** Shared exports are redacted so secrets never appear in them (see [F13](./F13-collaboration-sharing.md)).
- **FR-8** In hosted deployment, access to a Workspace's secrets follows its access control
  (see [F16](./F16-platform-deployment.md)).

## Non-functional requirements

- **NFR-1** No log, notification, report, or export contains a secret in readable form.
- **NFR-2** The product operates without sending any data externally by default
  (product [NFR-5](../product/03-product-requirements.md)).
- **NFR-3** A revoked or expired secret disables only the work that depends on it, cleanly.

## States & rules

- Secrets are Workspace-scoped resources.
- The boundary rule is absolute: agent-run code never has access to raw credentials.
- Subscription and API-key credentials use the same secure storage and handling.

## Edge cases & failure handling

- If a secret is revoked while in use, dependent Tasks pause with a clear
  re-authentication path rather than failing unsafely (see [F06](./F06-authentication-billing.md)).
- If redaction of an export cannot be guaranteed, the export is withheld (see [F13](./F13-collaboration-sharing.md)).

## Out of scope

- The specific cryptographic mechanisms used (an architecture and operational concern).

## Related

- [F06 — Authentication & Billing Modes](./F06-authentication-billing.md)
- [F12 — External Integrations](./F12-integrations.md)
- [F13 — Collaboration & Sharing](./F13-collaboration-sharing.md)
- [F16 — Platform, Deployment & Multi-Tenancy](./F16-platform-deployment.md)
- [Architecture — Cross-cutting Concepts](../architecture/08-crosscutting-concepts.md)
