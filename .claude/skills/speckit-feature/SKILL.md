---
name: "speckit-feature"
description: "Full-stack Next.js feature scaffold. Walks through Contract-First schemas → Drizzle table → DAL → Services → Server Actions → RSC page → Client form → Inngest worker → Tests. Generates every file for a complete feature slice."
compatibility: "Requires spec-kit project structure with .specify/ directory"
metadata:
  author: "github-spec-kit"
  source: "templates/commands/feature.md"
user-invocable: true
disable-model-invocation: false
---


## User Input

```text
$ARGUMENTS
```

Parse the first positional argument as the **feature name** (singular, PascalCase noun — e.g. `Invoice`, `Workspace`, `Subscription`).

Optional flags (all can be combined):

| Flag                   | Meaning                                                | Default             |
| ---------------------- | ------------------------------------------------------ | ------------------- |
| `--description <text>` | One-line feature description                           | `""`                |
| `--fields <list>`      | Comma-separated field definitions `name:type`          | inferred            |
| `--skip-db`            | Skip Phase 1 (table already exists)                    | generate table      |
| `--skip-queue`         | Skip Phase 7 (no async side effects)                   | generate Inngest fn |
| `--skip-tests`         | Skip Phase 9 test files                                | generate tests      |
| `--skip-ship`          | Skip Phase 10 ship checklist                           | include checklist   |
| `--id-type <type>`     | Primary key type                                       | `cuid2`             |
| `--auth`               | Feature requires authentication + workspace membership | `true`              |
| `--no-auth`            | Feature is public                                      | `false`             |
| `--db-type <type>`     | DB hint (`pg`, `sqlite`, `mysql`)                      | `pg`                |
| `--only <phases>`      | Comma-separated phases to execute (e.g. `0,1,2`)       | all phases          |
| `--dry-run`            | Print file contents instead of writing                 | skip writes         |

If feature name is missing, ask for it before proceeding.

---

## Pre-Execution Checks

Check for `.specify/extensions.yml`. If present, look for hooks under `hooks.before_feature`. Apply standard hook-processing: skip disabled hooks, skip hooks with non-empty condition, surface optional hooks as instructions, auto-execute mandatory hooks.

Check for `lib/db/schema/index.ts` and `lib/dal/` — if neither exists, warn that this project does not follow the expected structure and ask whether to proceed (the AI will adapt paths to whatever structure is found).

---

## Feature Scaffold

This scaffold walks through 10 phases. Each phase produces one or more files. After all phases complete, run the verification checklist.

### Phase 0 — Contract First (Schemas)

**Goal**: Define the Zod schemas and inferred types before any implementation.

**Generate**: `schemas/<feature-kebab>.schema.ts`

```ts
// schemas/<feature-kebab>.schema.ts
import { z } from "zod";

// ─── Input Schemas ───────────────────────────────────────────────────────────

export const Create<Feature>Input = z.object({
  // <fields-derived-from-user-input>
  <if:auth>  workspaceId: z.string().cuid2(),</if:auth>
  // <name>: <zod-type>(),
});

export const Update<Feature>Input = Create<Feature>Input.partial();

// <if:has-status>
export const <Feature>Status = z.enum(["draft", "active", "archived"]);
// </if:has-status>

// ─── Output / DTO Schemas ────────────────────────────────────────────────────

export const <Feature>Dto = z.object({
  id:        z.string(),
  // <fields-derived-from-db>
  createdAt: z.date(),
  updatedAt: z.date(),
});

// ─── Inferred Types ──────────────────────────────────────────────────────────

export type Create<Feature>Input = z.infer<typeof Create<Feature>Input>;
export type Update<Feature>Input = z.infer<typeof Update<Feature>Input>;
export type <Feature>Dto         = z.infer<typeof <Feature>Dto>;
```

**Checklist**:

- [ ] Every input field has a Zod constraint (`min`, `max`, `positive`, `email`, `cuid2`, etc.)
- [ ] `Create<Feature>Input` and `Update<Feature>Input` are separate schemas
- [ ] `<Feature>Dto` exposes only what the client needs — no internal fields
- [ ] Types are inferred — never duplicated by hand

---

### Phase 1 — Database Schema (Drizzle)

**Goal**: Express the domain in Drizzle, generate types.

**Generate**: `lib/db/schema/<feature-kebab>.ts`

```ts
// lib/db/schema/<feature-kebab>.ts
import { pgTable, text, timestamp, <types> } from "drizzle-orm/pg-core";
import { createId } from "@paralleldrive/cuid2";
import { <if:auth>workspaces } from "./workspace";</if:auth>

export const <featureSnake> = pgTable(
  "<feature_snake>",
  {
    id:          text("id").primaryKey().$defaultFn(() => createId()),
    // <if:auth>
    workspaceId: text("workspace_id").notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),</if:auth>
    // <fields-derived-from-user-input>: <column-definitions>
    createdAt:   timestamp("created_at", { withTimezone: true })
      .notNull().$defaultFn(() => new Date()),
    updatedAt:   timestamp("updated_at", { withTimezone: true })
      .notNull().$defaultFn(() => new Date()),
  },
  // <if:has-constraints>
  (t) => [/* check constraints */],// </if:has-constraints>
);

export type <Feature>    = typeof <featureSnake>.$inferSelect;
export type New<Feature> = typeof <featureSnake>.$inferInsert;
```

**Also update**: `lib/db/schema/index.ts` — add the export.

**Checklist**:

- [ ] Primary key is `cuid2()` — no serial IDs
- [ ] `createdAt` / `updatedAt` with `$defaultFn`
- [ ] `workspaceId` FK with `onDelete: "cascade"` (if multi-tenant)
- [ ] DB-level constraints (`check`, `notNull`, `unique`) added
- [ ] Enum columns use `pgEnum` for string enums
- [ ] `$inferSelect` / `$inferInsert` types exported
- [ ] Run `drizzle-kit generate` and inspect the SQL diff before migrating

---

### Phase 2 — Data Access Layer (DAL)

**Goal**: Single choke-point for every DB interaction. AuthZ lives here.

**Generate**: `lib/dal/<feature-kebab>.dal.ts`

```ts
// lib/dal/<feature-kebab>.dal.ts
import "server-only";
import { unstable_cache } from "next/cache";
import { eq, and, desc } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { <featureSnake> } from "@/lib/db/schema";
import { getRequiredSession } from "@/lib/dal/session";

const CACHE_TAG = "<featureSnake>";

// ─── Reads ────────────────────────────────────────────────────────────────────

export const get<Feature>ById = (id: string) =>
  unstable_cache(
    async () => {
      const { session } = await getRequiredSession();
      // <if:auth>
      // await assertMember(session.user.id, id);</if:auth>
      return db.query.<featureSnake>.findFirst({
        where: eq(<featureSnake>.id, id),
      }) ?? null;
    },
    [`<featureSnake>:${id}`],
    { tags: [`<featureSnake>:${id}`] },
  )();

export const get<Feature>sByWorkspace = (workspaceId: string) =>
  unstable_cache(
    async () => {
      // const { session } = await getRequiredSession();
      // await assertMember(session.user.id, workspaceId);
      return db.query.<featureSnake>.findMany({
        // where: eq(<featureSnake>.workspaceId, workspaceId),
        orderBy: (t, { desc }) => desc(t.createdAt),
      });
    },
    [`<featureSnake>s:${workspaceId}`],
    { tags: [`<featureSnake>s:${workspaceId}`] },
  )();

// ─── Writes ───────────────────────────────────────────────────────────────────

export const create<Feature>Record = async (
  data: Omit<<Feature>, "id" | "createdAt" | "updatedAt">,
) => {
  // const { session } = await getRequiredSession();
  // await assertMember(session.user.id, data.workspaceId);
  const [row] = await db.insert(<featureSnake>).values(data).returning();
  if (!row) throw new Error("<FEATURE>_INSERT_FAILED");
  return row;
};

export const update<Feature>Record = async (
  id: string,
  data: Partial<Omit<<Feature>, "id" | "createdAt" | "updatedAt">>,
) => {
  // const { session } = await getRequiredSession();
  const [row] = await db.update(<featureSnake>)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(<featureSnake>.id, id))
    .returning();
  if (!row) throw new Error("<FEATURE>_UPDATE_FAILED");
  return row;
};

export const delete<Feature>Record = async (id: string) => {
  // const { session } = await getRequiredSession();
  await db.delete(<featureSnake>).where(eq(<featureSnake>.id, id));
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

// async function assertMember(userId: string, workspaceId: string) {
//   // query workspace_members table; throw if not found
// }
```

**Checklist**:

- [ ] `import "server-only"` as first meaningful line
- [ ] Session re-verified in every read and write
- [ ] Queries scoped by `workspaceId` (multi-tenant safety)
- [ ] Reads wrapped with `unstable_cache` and tagged
- [ ] Writes return the affected row — no `returning()` is a bug
- [ ] Typed errors (never leak raw `db` errors)
- [ ] No caller ever imports `db` directly

---

### Phase 3 — Business Logic (Services)

**Goal**: Pure, side-effect-free functions. Unit-testable in isolation.

**Generate**: `lib/services/<feature-kebab>.service.ts`

```ts
// lib/services/<feature-kebab>.service.ts
import type { Create<Feature>Input, Update<Feature>Input } from "@/schemas/<feature-kebab>.schema";

export const buildCreatePayload = (input: Create<Feature>Input) => ({
  // map input → DB shape
  // <fields>
});

export const buildUpdatePayload = (input: Update<Feature>Input) => ({
  // map input → DB shape
  // <fields>
});

export const validate<Feature>State = (status: string): boolean => {
  // pure state machine check — no side effects, no DB
  return ["draft", "active", "archived"].includes(status);
};
```

**Checklist**:

- [ ] No DB imports, no `headers()`, no `cookies()`, no `"use server"`
- [ ] Input and output are plain TS types (inferred from Zod schemas)
- [ ] Every branch is a pure expression — no mutation
- [ ] Export one function per use-case
- [ ] Unit tests cover every branch (see Phase 9)

---

### Phase 4 — Server Actions

**Goal**: Thin orchestrator. Auth → validate → rate-limit → service → DAL → enqueue → revalidate.

**Generate**: `lib/actions/<feature-kebab>.actions.ts`

```ts
// lib/actions/<feature-kebab>.actions.ts
"use server";
import { revalidateTag } from "next/cache";
import { headers } from "next/headers";
import { Ratelimit } from "@upstash/ratelimit";
import { redis } from "@/lib/upstash";
import { authAction } from "@/lib/actions/safe-action";
import { create<Feature>Record } from "@/lib/dal/<feature-kebab>.dal";
// import { buildCreatePayload } from "@/lib/services/<feature-kebab>.service";
// <if:queue>import { inngest } from "@/lib/inngest";</if:queue>
import { logger } from "@/lib/logger";
import { Create<Feature>Input } from "@/schemas/<feature-kebab>.schema";

const ratelimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(10, "1m"),
});

export const create<Feature>Action = authAction
  .inputSchema(Create<Feature>Input)
  .action(async ({ parsedInput, ctx: { session } }) => {
    const correlationId = crypto.randomUUID();
    const start = performance.now();
    logger.info({ correlationId, event: "<feature>.create.start", userId: session.user.id });

    // 1. Rate-limit
    const ip = (await headers()).get("x-forwarded-for") ?? "127.0.0.1";
    const { success } = await ratelimit.limit(`<feature>:create:${session.user.id}:${ip}`);
    if (!success) throw new Error("RATE_LIMITED");

    // 2. Business logic (pure)
    // const payload = buildCreatePayload(parsedInput);

    // 3. DAL write
    const record = await create<Feature>Record(parsedInput as any);

    // <if:queue>
    // 4. Enqueue side effects
    await inngest.send({ name: "<feature>/created", data: { id: record.id } });
    // </if:queue>

    // 5. Surgical cache invalidation
    revalidateTag(`<featureSnake>s:${parsedInput.workspaceId}`);

    // 6. Log
    logger.info({
      correlationId, event: "<feature>.create.success",
      durationMs: performance.now() - start,
      userId: session.user.id,
    });

    return { id: record.id };
  });
```

**Checklist**:

- [ ] Uses `authAction` from `safe-action.ts` (never raw `action`)
- [ ] Input schema attached via `.inputSchema()`
- [ ] Rate limit by IP + userId before any DB write
- [ ] Call service layer first (pure logic), then DAL
- [ ] Enqueue side effects — never `await` email/webhook in action body
- [ ] `revalidateTag` with precise tag — not `revalidatePath('/')`
- [ ] Log correlationId + userId + duration at action boundary
- [ ] Never expose stack traces to the client

---

### Phase 5 — Read Path (RSC)

**Goal**: Server Components read via DAL, stream with `<Suspense>`. Zero client JS for the happy path.

**Generate**: `app/(app)/[workspace]/<feature-kebab>/page.tsx`

```tsx
// app/(app)/[workspace]/<feature-kebab>/page.tsx
import { Suspense } from "react";
import { <Feature>Table } from "@/components/features/<feature-kebab>/<Feature>Table";
import { <Feature>TableSkeleton } from "@/components/features/<feature-kebab>/<Feature>TableSkeleton";
import { get<Feature>sByWorkspace } from "@/lib/dal/<feature-kebab>.dal";

interface Props {
  params: Promise<{ workspace: string }>;
}

export const metadata = {
  title: "<Feature>s | App",
  description: "Manage <feature>s",
};

export default async function <Feature>sPage({ params }: Props) {
  const { workspace } = await params;
  return (
    <Suspense fallback={<FeatureTableSkeleton />}>
      <FeatureList workspaceId={workspace} />
    </Suspense>
  );
}

async function FeatureList({ workspaceId }: { workspaceId: string }) {
  const records = await get<Feature>sByWorkspace(workspaceId);
  return <<Feature>Table records={records} />;
}
```

**Generate**: `app/(app)/[workspace]/<feature-kebab>/loading.tsx`

```tsx
// app/(app)/[workspace]/<feature-kebab>/loading.tsx
import { <Feature>TableSkeleton } from "@/components/features/<feature-kebab>/<Feature>TableSkeleton";

export default function Loading() {
  return <<Feature>TableSkeleton />;
}
```

**Generate**: `app/(app)/[workspace]/<feature-kebab>/error.tsx`

```tsx
// app/(app)/[workspace]/<feature-kebab>/error.tsx
"use client";

import { useEffect } from "react";

interface Props {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function <Feature>sError({ error, reset }: Props) {
  useEffect(() => { console.error(error); }, [error]);

  return (
    <div role="alert">
      <h2>Something went wrong</h2>
      <p>{error.message}</p>
      <button type="button" onClick={reset}>Try again</button>
    </div>
  );
}
```

**Checklist**:

- [ ] `page.tsx` is a Server Component — no `"use client"`
- [ ] Data fetched via DAL — not `fetch()` to own API
- [ ] Page wrapped in `<Suspense>` for streaming
- [ ] `loading.tsx` for segment-level skeleton
- [ ] `error.tsx` for segment-level error boundary
- [ ] Pass data as props to Client Components — never share fetch logic

---

### Phase 6 — Write Path (Client Component)

**Goal**: Minimal `"use client"` leaf. Form → Server Action → optimistic feedback.

**Generate**: `components/features/<feature-kebab>/Create<Feature>Form.tsx`

```tsx
// components/features/<feature-kebab>/Create<Feature>Form.tsx
"use client";

import { useAction } from "next-safe-action/hooks";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { create<Feature>Action } from "@/lib/actions/<feature-kebab>.actions";
import { Create<Feature>Input } from "@/schemas/<feature-kebab>.schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface Props {
  workspaceId: string;
  onSuccess?: () => void;
}

export function Create<Feature>Form({ workspaceId, onSuccess }: Props) {
  const form = useForm<Create<Feature>Input>({
    resolver: zodResolver(Create<Feature>Input),
    defaultValues: { workspaceId } as any,
  });

  const { execute, isPending, result } = useAction(create<Feature>Action, {
    onSuccess: () => {
      form.reset();
      onSuccess?.();
    },
  });

  return (
    <form onSubmit={form.handleSubmit(execute)} aria-busy={isPending}>
      {/* <fields> */}
      <Input
        type="text"
        placeholder="<Feature> name"
        aria-invalid={!!form.formState.errors.name}
        {...form.register("name")}
      />
      {form.formState.errors.name && (
        <p role="alert">{form.formState.errors.name.message}</p>
      )}

      {result.serverError && (
        <p role="alert" aria-live="polite">{result.serverError}</p>
      )}

      <Button type="submit" disabled={isPending}>
        {isPending ? "Creating…" : "Create <Feature>"}
      </Button>
    </form>
  );
}
```

**Generate**: `components/features/<feature-kebab>/<Feature>Table.tsx`

```tsx
// components/features/<feature-kebab>/<Feature>Table.tsx
"use client";

import type { <Feature>Dto } from "@/schemas/<feature-kebab>.schema";

interface Props {
  records: <Feature>Dto[];
}

export function <Feature>Table({ records }: Props) {
  if (records.length === 0) {
    return <p>No <Feature> records found.</p>;
  }

  return (
    <div role="table" aria-label="<Feature>s">
      <div role="rowgroup">
        {records.map((r) => (
          <div key={r.id} role="row">
            {/* render fields */}
          </div>
        ))}
      </div>
    </div>
  );
}
```

**Generate**: `components/features/<feature-kebab>/<Feature>TableSkeleton.tsx`

```tsx
// components/features/<feature-kebab>/<Feature>TableSkeleton.tsx
export function <Feature>TableSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading <Feature>s">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="animate-pulse h-12 w-full rounded bg-muted mb-2" />
      ))}
    </div>
  );
}
```

**Checklist**:

- [ ] `"use client"` only on these leaf components — not on the page
- [ ] `react-hook-form` + `zodResolver` for local validation
- [ ] `useAction` from `next-safe-action/hooks` to call the action
- [ ] Button disabled while pending — no double-submit
- [ ] Server-returned validation errors displayed field-by-field
- [ ] `aria-busy`, `aria-live`, `role="alert"` for a11y

---

### Phase 7 — Side Effects (Queue / Workers)

**Goal**: Slow / unreliable work runs outside the request. The action stays under 200ms.

**Generate**: `inngest/functions/<feature-kebab>.function.ts` _(skip if `--skip-queue`)_

```ts
// inngest/functions/<feature-kebab>.function.ts
import { inngest } from "@/lib/inngest";
import { db } from "@/lib/db/client";
import { <featureSnake> } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export const on<Feature>Created = inngest.createFunction(
  { id: "<feature>-created", retries: 3 },
  { event: "<feature>/created" },
  async ({ event, step }) => {
    const record = await step.run("fetch-<feature>", () =>
      db.query.<featureSnake>.findFirst({
        where: eq(<featureSnake>.id, event.data.id),
      }),
    );

    if (!record) throw new Error("<FEATURE>_NOT_FOUND");

    // Add side effects below:
    // await step.run("send-notification", () => sendEmail(...));
    // await step.run("call-webhook", () => fetch(...));
  },
);
```

**Checklist**:

- [ ] Function is idempotent — safe to retry on failure
- [ ] Retry strategy defined (`retries: 3`)
- [ ] External API calls wrapped in `step.run()` for atomicity
- [ ] Dead-letter / failure alert configured

---

### Phase 8 — Observability

**Goal**: Every action is traceable. Failures are loud.

```
Observability checklist (integrate into existing files):

/lib/logger.ts
  [ ] Structured logger configured (pino, winston, or console with correlationId)
  [ ] Log level configurable via LOG_LEVEL env var

/lib/actions/<feature-kebab>.actions.ts
  [ ] correlationId = crypto.randomUUID() at action entry
  [ ] Log start event with userId
  [ ] Log end event with durationMs
  [ ] Log validation errors, rate-limit rejections

Sentry / observability provider
  [ ] captureException in action catch blocks
  [ ] captureException in error.tsx useEffect
  [ ] OpenTelemetry span wraps the DAL call (if @vercel/otel configured)

Metrics
  [ ] Counter metric per action result: success / validation_error / rate_limited / unauthorized
  [ ] Alert on error rate spike (>5% error rate over 5 min window)

Cache
  [ ] Verify cache hit/miss is visible via x-nextjs-cache response header
```

---

### Phase 9 — Tests

**Goal**: Confidence without brittle tests. Unit → Integration → E2E.

**Generate**: `tests/unit/<feature-kebab>.service.test.ts` _(skip if `--skip-tests`)_

```ts
// tests/unit/<feature-kebab>.service.test.ts
import { describe, it, expect } from "vitest";
// import { buildCreatePayload, validate<Feature>State } from "@/lib/services/<feature-kebab>.service";

describe("<Feature> service", () => {
  describe("buildCreatePayload", () => {
    it("maps valid input to DB shape", () => {
      // const result = buildCreatePayload({ /* ... */ });
      // expect(result).toMatchObject({ /* ... */ });
    });
  });
});
```

**Generate**: `tests/integration/<feature-kebab>.action.test.ts` _(skip if `--skip-tests`)_

```ts
// tests/integration/<feature-kebab>.action.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/dal/session", () => ({
  getRequiredSession: vi.fn().mockResolvedValue({
    session: { user: { id: "user_01" } },
  }),
}));

// import { create<Feature>Action } from "@/lib/actions/<feature-kebab>.actions";

describe("create<Feature>Action", () => {
  it("returns id on valid input", async () => {
    // const result = await create<Feature>Action({ /* ... */ });
    // expect(result?.data?.id).toBeTypeOf("string");
  });

  it("rejects invalid input", async () => {
    // const result = await create<Feature>Action({ /* invalid */ });
    // expect(result?.validationErrors).toBeDefined();
  });
});
```

**Generate**: `tests/e2e/<feature-kebab>.spec.ts` _(skip if `--skip-tests`)_

```ts
// tests/e2e/<feature-kebab>.spec.ts
import { test, expect } from "@playwright/test";

test("create <feature> and verify it appears in the list", async ({ page }) => {
  // await page.goto("/login");
  // await page.fill("[name=email]", "test@example.com");
  // await page.fill("[name=password]", "password");
  // await page.click("button[type=submit]");
  // await page.goto(`/${workspace}/<feature-kebab>`);
  // await page.fill("[name=name]", "Test <Feature>");
  // await page.click("button[type=submit]");
  // await expect(page.locator("text=Test <Feature>")).toBeVisible();
});
```

**Checklist**:

- [ ] Unit test every branch in service layer
- [ ] Integration test the Server Action: mock session → call action → assert
- [ ] Integration test the DAL: unauthorized user → expect throw
- [ ] RTL test the form: validation error visible, button disabled while pending
- [ ] Playwright E2E: login → navigate → submit form → assert row appears
- [ ] No `@ts-ignore`, no `as any` in tests

---

### Phase 10 — Ship Checklist

```
[ ] Feature branch → PR with description linking to acceptance criteria
[ ] CI passes: biome check → tsc --noEmit → vitest run → next build
[ ] Preview deploy auto-created
[ ] PR reviewed: business logic + security checklist
[ ] Merge to main → production deploy
[ ] Feature flag enabled for internal users first
[ ] Monitor error rate for 30 min after enabling
[ ] Rollout 10% → 50% → 100%
[ ] Flag removed once stable (cleanup PR)
```

---

## Security Checklist

Run this against every generated action file before shipping:

```
Auth
  [ ] Session re-verified inside the action (not just in middleware)
  [ ] Role/membership checked in DAL before any DB operation
  [ ] No sensitive data returned to unauthorized callers

Input
  [ ] Zod schema attached via next-safe-action .inputSchema()
  [ ] No manual type casting of user-supplied values
  [ ] File uploads size + MIME type validated server-side

Rate limiting
  [ ] Upstash sliding window on IP + userId
  [ ] Burst limit for unauthenticated endpoints

Data
  [ ] Every query scoped by workspaceId (multi-tenant)
  [ ] No raw SQL interpolation (use Drizzle's sql`` tag with params)
  [ ] No full DB row returned when only subset needed

Output
  [ ] Generic error message to client ("Something went wrong")
  [ ] Full stack logged server-side only
  [ ] No internal IDs, emails, or secrets in client response

Cache
  [ ] revalidateTag is surgical (not revalidatePath('/'))
  [ ] No cache on user-specific sensitive data without scope tag

Infrastructure
  [ ] Secrets via env.ts (@t3-oss/env-nextjs) — build fails if missing
  [ ] No secrets in client bundles (no NEXT_PUBLIC_ for private values)
```

---

## Post-Scaffold Verification

After generating all files, verify:

1. **No `"use client"` on page.tsx** — all page files are Server Components
2. **No `import { db }` in components** — every DB query routes through the DAL
3. **No `await sendEmail(...)` in actions** — side effects use Inngest
4. **No `revalidatePath('/')`** — every mutation uses a precise `revalidateTag`
5. **No business logic in page.tsx or actions** — extracted to service layer
6. **All imports resolve** — run `tsc --noEmit` to verify
7. **Drizzle schema exported from `lib/db/schema/index.ts`**

Output the scaffold summary:

```
## Feature scaffold complete

**Feature**: `<Feature>`
**Description**: `<description>`

**Files created**:
  - schemas/<feature-kebab>.schema.ts ← Zod input/output schemas
  - lib/db/schema/<feature-kebab>.ts  ← Drizzle table definition
  - lib/dal/<feature-kebab>.dal.ts     ← Data access layer
  - lib/services/<feature-kebab>.service.ts ← Pure business logic
  - lib/actions/<feature-kebab>.actions.ts  ← Server Actions
  - app/(app)/[workspace]/<feature-kebab>/page.tsx ← RSC read page
  - app/(app)/[workspace]/<feature-kebab>/loading.tsx
  - app/(app)/[workspace]/<feature-kebab>/error.tsx
  - components/features/<feature-kebab>/Create<Feature>Form.tsx ← Client form
  - components/features/<feature-kebab>/<Feature>Table.tsx ← Client table
  - components/features/<feature-kebab>/<Feature>TableSkeleton.tsx ← Loading skeleton
  - inngest/functions/<feature-kebab>.function.ts ← Async worker
  - tests/unit/<feature-kebab>.service.test.ts       ← Unit tests
  - tests/integration/<feature-kebab>.action.test.ts ← Integration tests
  - tests/e2e/<feature-kebab>.spec.ts                  ← E2E tests

**Security checklist**: reviewed (see above)
**Verification**: run tsc --noEmit && vitest run

**Next steps**:
  - Run /speckit-plan <feature> for detailed planning
  - Run /speckit-scaffold-route <feature-kebab> to add/update route segments
  - Run /speckit-audit to verify compliance
```

## Post-Execution Hooks

Check `.specify/extensions.yml` for `hooks.after_feature`. Apply standard hook-processing.
