import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  DEFAULT_GITLAB_MAPPING,
  fieldsFromLabels,
  GITLAB_FIELD_SUPPORT,
  GITLAB_LABEL_TEMPLATE,
  GitlabProjects,
  valuesFromIssue,
} from "./gitlab-projects.js";

/**
 * GitLab planning against fixtures for **both a Free and a Premium instance** (#124 DoD).
 *
 * Two fixtures rather than one because the difference between them is the feature: a Free
 * instance is the common case, not a degraded one, and what it cannot do has to be said in words
 * rather than discovered when a save fails.
 */

let server: ReturnType<typeof Bun.serve>;
let paths: string[] = [];
/** The HTTP verb of each request, which is the half this suite used not to look at. */
let methods: string[] = [];
let response: unknown = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      paths.push(`${url.pathname}${url.search}`);
      methods.push(req.method);
      return Response.json(response);
    },
  });
});
afterAll(() => server.stop(true));

const credential = () => ({ token: "glpat-fixture", baseUrl: `http://localhost:${server.port}` });

const LABELS = [
  { id: 1, name: "status::todo", color: "#aaa" },
  { id: 2, name: "status::in-progress", color: "#bbb" },
  { id: 3, name: "priority::high", color: "#ccc" },
  { id: 4, name: "bug", color: "#ddd" },
];

describe("fieldsFromLabels", () => {
  it("groups a scope's labels into one single-select, not one field per label", () => {
    // The entire trick that makes GitLab look like a project: `status::todo` and
    // `status::in-progress` are two options of one field.
    const fields = fieldsFromLabels(LABELS, DEFAULT_GITLAB_MAPPING);
    const status = fields.find((f) => f.name === "Status");

    expect(status?.type).toBe("single_select");
    expect(status?.options.map((o) => o.name)).toEqual(["todo", "in-progress"]);
    // An unscoped label is not a field.
    expect(fields.some((f) => f.name === "bug")).toBe(false);
  });

  it("takes the prefix from configuration, because a convention is a convention", () => {
    // #124 AC-2. A team writing `Status::Doing` is not misconfigured, it is a team.
    const fields = fieldsFromLabels([{ id: 9, name: "Workflow::Doing", color: null }], {
      ...DEFAULT_GITLAB_MAPPING,
      scopedLabels: { Status: "Workflow" },
    });

    expect(fields.find((f) => f.name === "Status")?.options.map((o) => o.name)).toEqual(["Doing"]);
  });

  describe("on a Free instance", () => {
    it("lists what it cannot hold, read-only, with the reason naming the tier", () => {
      // #124 AC-3 and AC-6: usable on Free, with the unavailable fields named rather than hidden.
      const fields = fieldsFromLabels(LABELS, DEFAULT_GITLAB_MAPPING);
      const estimate = fields.find((f) => f.name === "Estimate");
      const iteration = fields.find((f) => f.name === "Iteration");

      expect(estimate).toMatchObject({ type: "number", readOnly: true });
      expect(estimate?.readOnlyReason).toMatch(/paid tier/i);
      expect(iteration).toMatchObject({ type: "iteration", readOnly: true });
    });

    it("still offers every scoped-label field as editable", () => {
      const fields = fieldsFromLabels(LABELS, DEFAULT_GITLAB_MAPPING);

      expect(fields.filter((f) => !f.readOnly).map((f) => f.name)).toEqual([
        "Status",
        "Priority",
        "Size",
      ]);
    });
  });

  describe("on a Premium instance", () => {
    it("stops refusing the fields the tier provides", () => {
      const fields = fieldsFromLabels(LABELS, {
        ...DEFAULT_GITLAB_MAPPING,
        hasIterations: true,
        hasWeights: true,
      });

      expect(fields.some((f) => f.name === "Estimate")).toBe(false);
      expect(fields.some((f) => f.name === "Iteration")).toBe(false);
    });

    it("still refuses per-issue dates, which no tier provides", () => {
      const fields = fieldsFromLabels(LABELS, {
        ...DEFAULT_GITLAB_MAPPING,
        hasIterations: true,
        hasWeights: true,
      });

      expect(fields.find((f) => f.name === "Start date")?.readOnly).toBe(true);
    });
  });
});

describe("valuesFromIssue", () => {
  it("reads the one label of a scope as that field's value", () => {
    const values = valuesFromIssue(
      { id: 5, iid: 5, title: "t", labels: ["status::in-progress", "bug"] },
      DEFAULT_GITLAB_MAPPING,
    );

    expect(values.find((v) => v.fieldExternalId === "label:status")?.value).toEqual({
      type: "single_select",
      optionId: "status::in-progress",
    });
  });

  it("leaves a scope with no label unset, which is not the same as empty", () => {
    // An empty cell, not a chosen-but-blank option — the table has to be able to draw the
    // difference between "not decided" and "decided to be nothing".
    const values = valuesFromIssue(
      { id: 5, iid: 5, title: "t", labels: [] },
      DEFAULT_GITLAB_MAPPING,
    );

    expect(values.find((v) => v.fieldExternalId === "label:status")?.value).toBeNull();
  });

  it("mirrors assignees, which are the provider's and not ours to author", () => {
    const values = valuesFromIssue(
      {
        id: 5,
        iid: 5,
        title: "t",
        labels: [],
        assignees: [{ username: "satcom", name: "Satcom", avatar_url: "a.png" }],
      },
      DEFAULT_GITLAB_MAPPING,
    );

    expect(values.find((v) => v.fieldExternalId === "assignees")?.value).toEqual({
      type: "user",
      users: [{ login: "satcom", name: "Satcom", avatarUrl: "a.png" }],
    });
  });
});

describe("writeProjectFieldValue", () => {
  it("adds and removes the scope in one request, never leaving the issue with neither", async () => {
    // #124 AC-4. GitLab enforces one label per scope, so this is two operations — and as two
    // requests there is a window where the issue carries none, which reads as unset to
    // everything watching.
    paths = [];
    methods = [];
    response = { id: 5, iid: 5, title: "t", labels: ["status::done"] };
    const projects = new GitlabProjects();

    const stored = await projects.writeProjectFieldValue(credential(), {
      projectExternalId: "42",
      itemExternalId: "5",
      fieldExternalId: "label:status",
      value: { type: "single_select", optionId: "status::done" },
    });

    expect(paths).toHaveLength(1);
    expect(paths[0]).toContain("add_labels=status%3A%3Adone");
    expect(paths[0]).toContain("remove_labels_scope=status%3A%3A");
    /*
     * And it is a PUT.
     *
     * This assertion is the point of the test, not a detail of it. The driver shipped issuing a
     * GET: GitLab answers a GET on this path with the *unchanged* issue, ignoring `add_labels`
     * entirely — 200, a plausible object, nothing written. The value was then read back out of
     * that unchanged answer, so a write that never happened reported the old value as the new
     * one. This suite asserted the query string and never the verb, which is why it passed.
     */
    expect(methods[0]).toBe("PUT");
    // And the answer is what GitLab now holds, read back from its own response.
    expect(stored.value).toEqual({ type: "single_select", optionId: "status::done" });
  });

  it("refuses a field it declared unexpressible rather than sending something GitLab rejects", async () => {
    paths = [];
    const projects = new GitlabProjects();

    const stored = await projects.writeProjectFieldValue(credential(), {
      projectExternalId: "42",
      itemExternalId: "5",
      fieldExternalId: "unavailable:estimate",
      value: { type: "number", number: 5 },
    });

    expect(paths).toHaveLength(0);
    expect(stored.value).toBeNull();
  });
});

describe("what this provider declares it can hold", () => {
  it("expresses single-selects and refuses numbers, dates and iterations", () => {
    // The declaration that keeps GitLab first-class rather than a degraded GitHub. Faking a
    // number inside a label name is how a planning tool starts lying about arithmetic.
    expect(GITLAB_FIELD_SUPPORT.expresses).toContain("single_select");
    expect(GITLAB_FIELD_SUPPORT.expresses).not.toContain("number");
    expect(GITLAB_FIELD_SUPPORT.cannot.number).toBeTruthy();
    expect(GITLAB_FIELD_SUPPORT.cannot.date).toBeTruthy();
    expect(GITLAB_FIELD_SUPPORT.cannot.iteration).toBeTruthy();
  });
});

describe("provisionProjectStructure", () => {
  it("creates only the labels that are missing", async () => {
    // Additive and idempotent: a second import must create nothing.
    paths = [];
    response = [
      { id: 1, name: "status::todo", color: "#111" },
      { id: 2, name: "status::doing", color: "#222" },
    ];
    const projects = new GitlabProjects();

    const result = await projects.provisionProjectStructure(credential(), "42");

    expect(result.existing).toContain("status::todo");
    expect(result.created).not.toContain("status::todo");
    expect(result.created).toContain("status::done");
    expect(result.created).toContain("priority::high");
    expect(result.created).toContain("size::XL");
  });

  it("never touches a label that already exists, whatever its colour", async () => {
    // A scoped label drives the team's boards and filters, not just this table. Creating
    // structure without asking is one thing; overwriting somebody's definition is another.
    paths = [];
    response = [{ id: 1, name: "status::todo", color: "#ff0000" }];
    const projects = new GitlabProjects();

    await projects.provisionProjectStructure(credential(), "42");

    // One read, then only creations — no request carries the existing label's name.
    const writes = paths.filter((p) => p.includes("name="));
    expect(writes.some((p) => p.includes("status%3A%3Atodo"))).toBe(false);
    expect(writes.length).toBeGreaterThan(0);
  });

  it("matches an existing label case-insensitively, as GitLab does", async () => {
    // A team writing `Status::Todo` already has that label. Creating `status::todo` beside it
    // would give them two labels meaning one thing.
    paths = [];
    response = [{ id: 1, name: "Status::Todo", color: "#111" }];
    const projects = new GitlabProjects();

    const result = await projects.provisionProjectStructure(credential(), "42");

    expect(result.existing).toContain("status::todo");
    expect(result.created).not.toContain("status::todo");
  });

  it("creates nothing on a repository that already has the whole template", async () => {
    paths = [];
    response = Object.entries(GITLAB_LABEL_TEMPLATE).flatMap(([prefix, values]) =>
      values.map((v, i) => ({ id: i, name: `${prefix}::${v}`, color: null })),
    );
    const projects = new GitlabProjects();

    const result = await projects.provisionProjectStructure(credential(), "42");

    expect(result.created).toEqual([]);
    expect(paths.filter((p) => p.includes("name="))).toHaveLength(0);
  });
});
