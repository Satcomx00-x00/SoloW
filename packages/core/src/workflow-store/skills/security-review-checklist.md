---
name: security-review-checklist
description: "What to look for in a security pass — input, auth, secrets, injection, dependencies — and how to report it."
---

# Security review checklist

Work through every section against the code in front of you. Report a finding only when you can
point at the file and line and describe the input that reaches it; a class of bug you could not
locate is a note, not a finding.

## Input and trust boundaries
- Every value that crosses a boundary (HTTP, CLI, file, queue, env) is validated before use, and
  the validation is where the value enters, not where it is used.
- Sizes and counts are bounded: request bodies, uploads, page sizes, loop counts.

## Authentication and authorisation
- Every handler that touches tenant data checks the tenant of the *row*, not only of the caller.
- Ids sent by the caller are resolved through a scoped read before they are written anywhere.
- Privileged operations are behind an explicit role check, not behind the UI that hides the button.

## Injection
- SQL is parameterised; shell commands take argument arrays, never interpolated strings; paths are
  resolved and checked to stay under their root before being opened.
- Anything rendered into HTML, Markdown, or a template is escaped by the renderer, not by hand.

## Secrets and logging
- No credential appears in source, fixtures, logs, error messages, URLs, or the summary you write.
- Encrypted values are decrypted at the point of use and never returned from a read API.

## Dependencies and configuration
- New dependencies are pinned and justified; known advisories against the lockfile are listed.
- Debug modes, permissive CORS, and default credentials cannot ship on by accident.

## Reporting
For each finding: **severity** (critical / high / medium / low), **where** (file:line),
**what** (the flaw), **how** (the input that triggers it), **fix** (one sentence). Order by
severity. Say explicitly which sections you checked and found clean.
