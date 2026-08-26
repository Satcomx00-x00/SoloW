import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  GithubProjects,
  toExternalField,
  toExternalValue,
  toMutationValue,
} from "./github-projects.js";
import { ScmProviderError } from "./types.js";

/**
 * Projects v2 against a scripted GraphQL fixture, never a live API (Principle VI, #123 DoD).
 *
 * The pure translators are tested directly rather than only through the server, because they are
 * where the provider's vocabulary becomes the product's and where a wrong answer is silent: a
 * mis-read field type renders the wrong editor, and a mis-read iteration is a date range that is
 * one day out for ever.
 */

let server: ReturnType<typeof Bun.serve>;
let bodies: Array<{ query: string; variables: Record<string, unknown> }> = [];
let nextResponse: unknown = null;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { query: string; variables: Record<string, unknown> };
      bodies.push(body);
      return Response.json(nextResponse);
    },
  });
});
afterAll(() => server.stop(true));

const credential = () => ({ token: "ghp-fixture", baseUrl: `http://localhost:${server.port}` });
const projects = new GithubProjects();

describe("toExternalField", () => {
  it("maps GitHub's data types onto the product's union", () => {
    expect(
      toExternalField({ id: "f1", name: "Status", dataType: "SINGLE_SELECT" }, 0),
    ).toMatchObject({ type: "single_select", readOnly: false });
    expect(toExternalField({ id: "f2", name: "Estimate", dataType: "NUMBER" }, 1).type).toBe(
      "number",
    );
  });

  it("keeps a type it cannot render, read-only and named as GitHub names it", () => {
    // A column set that silently omits what it cannot render lies about what the project holds.
    const field = toExternalField({ id: "f3", name: "Tracks", dataType: "TRACKS" }, 2);

    expect(field.name).toBe("Tracks");
    expect(field.readOnly).toBe(true);
    expect(field.readOnlyReason).toContain("TRACKS");
  });

  it("reads an iteration's end date inclusively", () => {
    // A 14-day iteration starting on the 1st ends on the 14th. Off by one here is a roadmap
    // that is one day wrong on every bar, for ever.
    const field = toExternalField(
      {
        id: "f4",
        name: "Sprint",
        dataType: "ITERATION",
        configuration: {
          duration: 14,
          iterations: [{ id: "it1", title: "Sprint 1", startDate: "2026-08-01", duration: 14 }],
        },
      },
      3,
    );

    expect(field.iterations[0]).toEqual({
      id: "it1",
      title: "Sprint 1",
      startDate: "2026-08-01",
      endDate: "2026-08-14",
    });
  });

  it("carries completed iterations too, so a past row still names its sprint", () => {
    const field = toExternalField(
      {
        id: "f5",
        name: "Sprint",
        dataType: "ITERATION",
        configuration: {
          duration: 7,
          iterations: [{ id: "now", title: "Now", startDate: "2026-08-15", duration: 7 }],
          completedIterations: [
            { id: "past", title: "Past", startDate: "2026-08-01", duration: 7 },
          ],
        },
      },
      0,
    );

    expect(field.iterations.map((i) => i.id)).toEqual(["now", "past"]);
  });
});

describe("toExternalValue", () => {
  it("reads each value shape out of the GraphQL union", () => {
    expect(toExternalValue({ field: { id: "f" }, number: 3 })?.value).toEqual({
      type: "number",
      number: 3,
    });
    expect(toExternalValue({ field: { id: "f" }, optionId: "o" })?.value).toEqual({
      type: "single_select",
      optionId: "o",
    });
    expect(
      toExternalValue({ field: { id: "f" }, users: { nodes: [{ login: "octocat" }] } })?.value,
    ).toEqual({ type: "user", users: [{ login: "octocat", name: null, avatarUrl: null }] });
  });

  it("drops a value with no field behind it rather than guessing", () => {
    expect(toExternalValue({ number: 3 })).toBeNull();
  });
});

describe("readProjectItems", () => {
  it("returns rows with their values, and a cursor while there are more pages", async () => {
    bodies = [];
    nextResponse = {
      data: {
        node: {
          items: {
            pageInfo: { hasNextPage: true, endCursor: "CUR2" },
            nodes: [
              {
                id: "PVTI_1",
                isArchived: false,
                content: { __typename: "Issue", id: "I_1", databaseId: 42 },
                fieldValues: { nodes: [{ field: { id: "f1" }, optionId: "opt-todo" }] },
              },
            ],
          },
        },
      },
    };

    const page = await projects.readProjectItems(credential(), "PVT_1", null);

    expect(page.items).toHaveLength(1);
    // `42`, the database id — not `I_1`, the GraphQL node id. `listIssues` persists the former
    // as `issue.external_id` and `refreshProject` joins on it, so reporting the node id here made
    // every project row unresolvable and the table permanently empty. The two capabilities have
    // to name an issue the same way.
    expect(page.items[0]).toMatchObject({ externalId: "PVTI_1", issueExternalId: "42" });
    expect(page.nextCursor).toBe("CUR2");
  });

  it("resumes from a stored cursor rather than starting over", async () => {
    // #123 AC-2. A 2000-item project is several pages, and a restart mid-sync must not re-read
    // the ones already stored.
    bodies = [];
    nextResponse = { data: { node: { items: { pageInfo: { hasNextPage: false }, nodes: [] } } } };

    await projects.readProjectItems(credential(), "PVT_1", "CUR2");

    expect(bodies[0]?.variables.after).toBe("CUR2");
  });

  it("skips a draft item, which has no issue behind it", async () => {
    // Every row in this table is an Issue (F23, Out of scope). A draft given a synthetic issue
    // would be a row nothing else in the product could find.
    bodies = [];
    nextResponse = {
      data: {
        node: {
          items: {
            pageInfo: { hasNextPage: false },
            nodes: [
              { id: "PVTI_draft", content: null, fieldValues: { nodes: [] } },
              {
                id: "PVTI_real",
                content: { __typename: "Issue", id: "I_9", databaseId: 9 },
                fieldValues: { nodes: [] },
              },
            ],
          },
        },
      },
    };

    const page = await projects.readProjectItems(credential(), "PVT_1", null);

    expect(page.items.map((i) => i.externalId)).toEqual(["PVTI_real"]);
    // Skipped, but not vanished. A table shorter than the same project on GitHub with nothing to
    // explain the difference reads as a broken import; the count is what lets the UI say so.
    expect(page.drafts).toBe(1);
    expect(page.pullRequests).toBe(0);
  });

  it("counts a pull-request row apart from a draft, because they are different facts", async () => {
    // Both are dropped — every row here is an Issue — but telling the operator they have three
    // drafts when they have three pull requests is a wrong answer stated confidently.
    nextResponse = {
      data: {
        node: {
          items: {
            pageInfo: { hasNextPage: false },
            nodes: [
              {
                id: "PVTI_pr",
                content: { __typename: "PullRequest", id: "PR_1", databaseId: 77 },
                fieldValues: { nodes: [] },
              },
              { id: "PVTI_draft", content: null, fieldValues: { nodes: [] } },
            ],
          },
        },
      },
    };

    const page = await projects.readProjectItems(credential(), "PVT_1", null);

    expect(page.items).toHaveLength(0);
    expect(page.pullRequests).toBe(1);
    expect(page.drafts).toBe(1);
  });

  it("carries the issue itself, so a project can span repositories nobody connected", async () => {
    // The bug this exists for: a project's rows come from repositories the Workspace has never
    // added, so every row was skipped for want of an Issue — on every pass, for ever — and the
    // table stayed empty behind a count that read like a race.
    nextResponse = {
      data: {
        node: {
          items: {
            pageInfo: { hasNextPage: false },
            nodes: [
              {
                id: "PVTI_x",
                content: {
                  __typename: "Issue",
                  id: "I_x",
                  databaseId: 512,
                  number: 7,
                  title: "Latch sticks",
                  body: "in the rain",
                  url: "https://github.com/acme/gate/issues/7",
                  state: "CLOSED",
                  updatedAt: "2026-08-01T00:00:00.000Z",
                  repository: { nameWithOwner: "acme/gate" },
                  assignees: { nodes: [{ login: "ada", name: "Ada", avatarUrl: null }] },
                  labels: { nodes: [{ name: "hardware" }] },
                },
                fieldValues: { nodes: [] },
              },
            ],
          },
        },
      },
    };

    const page = await projects.readProjectItems(credential(), "PVT_1", null);

    expect(page.items[0]?.issue).toMatchObject({
      repositoryFullName: "acme/gate",
      // The same id space the row itself reports, so importing the issue makes the row resolve.
      externalId: "512",
      number: 7,
      title: "Latch sticks",
      state: "closed",
      labels: ["hardware"],
    });
    expect(page.items[0]?.issue?.assignees?.[0]?.login).toBe("ada");
  });

  it("omits the carried issue rather than half-building one when the repository is absent", async () => {
    // Absent means "could not say" everywhere else in this interface; an issue with no repository
    // could not be connected anyway, and inventing a name would create a Repository row pointing
    // at nothing.
    nextResponse = {
      data: {
        node: {
          items: {
            pageInfo: { hasNextPage: false },
            nodes: [
              {
                id: "PVTI_x",
                content: {
                  __typename: "Issue",
                  id: "I_x",
                  databaseId: 512,
                  number: 7,
                  title: "Latch sticks",
                  repository: null,
                },
                fieldValues: { nodes: [] },
              },
            ],
          },
        },
      },
    };

    const page = await projects.readProjectItems(credential(), "PVT_1", null);

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.issue).toBeUndefined();
  });

  it("asks for items and their values in one query, not one query per item", async () => {
    // #123 AC-6: Projects v2 charges points per query. An N+1 exhausts the hourly budget on the
    // first sync of a large project, which then looks like an outage rather than a mistake.
    bodies = [];
    nextResponse = { data: { node: { items: { pageInfo: { hasNextPage: false }, nodes: [] } } } };

    await projects.readProjectItems(credential(), "PVT_1", null);

    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.query).toContain("fieldValues");
  });
});

describe("writeProjectFieldValue", () => {
  it("answers with what GitHub now holds, not with what was sent", async () => {
    // #122 AC-3, and the reason it matters: a provider may normalise or refuse part of a value,
    // and rendering the typed value back would show the operator their own input as though it
    // were stored.
    nextResponse = {
      data: {
        updateProjectV2ItemFieldValue: {
          projectV2Item: {
            id: "PVTI_1",
            fieldValues: { nodes: [{ field: { id: "f1" }, optionId: "opt-actually-stored" }] },
          },
        },
      },
    };

    const stored = await projects.writeProjectFieldValue(credential(), {
      projectExternalId: "PVT_1",
      itemExternalId: "PVTI_1",
      fieldExternalId: "f1",
      value: { type: "single_select", optionId: "opt-i-asked-for" },
    });

    expect(stored.value).toEqual({ type: "single_select", optionId: "opt-actually-stored" });
  });

  it("sends the input shape each field type needs", () => {
    expect(toMutationValue({ type: "number", number: 5 })).toEqual({ number: 5 });
    expect(toMutationValue({ type: "single_select", optionId: "o" })).toEqual({
      singleSelectOptionId: "o",
    });
    expect(toMutationValue({ type: "iteration", iterationId: "it" })).toEqual({
      iterationId: "it",
    });
  });
});

describe("when GraphQL answers 200 with errors", () => {
  it("throws rather than rendering an empty project", async () => {
    // The trap this whole helper exists for: GraphQL reports failure inside a 200, so a caller
    // checking `res.ok` would read a failed query as "this project has no items".
    nextResponse = { errors: [{ message: "Could not resolve to a node with the global id" }] };

    expect(projects.readProjectItems(credential(), "PVT_missing", null)).rejects.toThrow(
      ScmProviderError,
    );
  });

  it("does not put the token in the error", async () => {
    nextResponse = { errors: [{ message: "Bad credentials" }] };

    try {
      await projects.readProjectFields(credential(), "PVT_1");
      expect.unreachable();
    } catch (cause) {
      expect(String(cause)).not.toContain("ghp-fixture");
    }
  });
});

describe("the id space a project reports an issue in", () => {
  it("is the one `listIssues` persists, not GraphQL's node id", async () => {
    // The defect this guards: Projects v2 identifies an issue as `I_kwDO…` while the REST issues
    // endpoint writes a numeric id. Joining the two on `issue.external_id` then matched nothing,
    // every row was counted as "waiting on its issue", and the table was empty for ever — with a
    // skipped count that read like a race rather than a mismatch.
    nextResponse = {
      data: {
        node: {
          items: {
            pageInfo: { hasNextPage: false },
            nodes: [
              {
                id: "PVTI_x",
                content: { __typename: "Issue", id: "I_kwDOAbCdEf", databaseId: 987654 },
                fieldValues: { nodes: [] },
              },
            ],
          },
        },
      },
    };

    const page = await projects.readProjectItems(credential(), "PVT_1", null);

    expect(page.items[0]?.issueExternalId).toBe("987654");
    expect(page.items[0]?.issueExternalId).not.toContain("I_kwDO");
  });

  it("skips a row whose content carries no database id rather than falling back to the node id", async () => {
    // A fallback would reintroduce the mismatch for exactly the rows that hit it, which is worse
    // than a row that is honestly absent.
    nextResponse = {
      data: {
        node: {
          items: {
            pageInfo: { hasNextPage: false },
            nodes: [
              {
                id: "PVTI_y",
                content: { __typename: "Issue", id: "I_only" },
                fieldValues: { nodes: [] },
              },
            ],
          },
        },
      },
    };

    const page = await projects.readProjectItems(credential(), "PVT_1", null);

    expect(page.items).toEqual([]);
  });
});

describe("listProjects", () => {
  it("returns organization projects, not only the viewer's own", () => {
    // The defect: the query declared `organization(login:)`, passed an empty login and read only
    // `viewer`. A team's project lives in an organization, so an operator on a company account
    // saw an empty picker with no reason given.
    nextResponse = {
      data: {
        viewer: {
          login: "satcom",
          projectsV2: { nodes: [{ id: "PVT_mine", title: "Personal", url: "u/mine" }] },
          organizations: {
            nodes: [
              {
                login: "northwind",
                projectsV2: { nodes: [{ id: "PVT_org", title: "Roadmap", url: "u/org" }] },
              },
            ],
          },
        },
      },
    };

    return projects.listProjects(credential()).then((found) => {
      expect(found.map((p) => p.externalId)).toEqual(["PVT_mine", "PVT_org"]);
    });
  });

  it("says whose each project is, so two Roadmaps are distinguishable", () => {
    nextResponse = {
      data: {
        viewer: {
          login: "satcom",
          projectsV2: { nodes: [] },
          organizations: {
            nodes: [
              { login: "acme", projectsV2: { nodes: [{ id: "A", title: "Roadmap", url: "u/a" }] } },
              {
                login: "northwind",
                projectsV2: { nodes: [{ id: "N", title: "Roadmap", url: "u/n" }] },
              },
            ],
          },
        },
      },
    };

    return projects.listProjects(credential()).then((found) => {
      expect(found.map((p) => `${p.ownerLogin}/${p.title}`)).toEqual([
        "acme/Roadmap",
        "northwind/Roadmap",
      ]);
    });
  });

  it("still lists the viewer's own when the token cannot read organizations", () => {
    // Without `read:org` GitHub returns an empty list rather than an error, so this is the shape
    // a under-scoped token actually produces — it must degrade, not break.
    nextResponse = {
      data: {
        viewer: {
          login: "satcom",
          projectsV2: { nodes: [{ id: "PVT_mine", title: "Personal", url: "u/mine" }] },
          organizations: { nodes: [] },
        },
      },
    };

    return projects.listProjects(credential()).then((found) => {
      expect(found).toHaveLength(1);
      expect(found[0]?.ownerLogin).toBe("satcom");
    });
  });

  it("asks for both in one query, not one per organization", () => {
    // Projects v2 charges points per query; a fan-out over twenty orgs would spend the hourly
    // budget answering "which projects exist".
    bodies = [];
    nextResponse = {
      data: { viewer: { login: "s", projectsV2: { nodes: [] }, organizations: { nodes: [] } } },
    };

    return projects.listProjects(credential()).then(() => {
      expect(bodies).toHaveLength(1);
      expect(bodies[0]?.query).toContain("organizations");
    });
  });
});
