import { describe, expect, it } from "bun:test";
import {
  connectIntegrationInput,
  connectRepositoryInput,
  createTaskInput,
  importIssuesInput,
  MAX_SETUP_FILE_PATTERNS,
  MAX_TASK_REPOSITORIES,
  reviewDecisionInput,
  setSecretInput,
  setTaskRepositoriesInput,
  setupFilePatternSchema,
  setupFilePatternsSchema,
  taskCheckoutBranch,
  taskEventSchema,
  todoItemSchema,
} from "./index.js";

describe("connectIntegrationInput (issue #15)", () => {
  it("accepts a GitHub connection with no baseUrl (public SaaS)", () => {
    const res = connectIntegrationInput.safeParse({ provider: "github", secretId: "sec_1" });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.baseUrl).toBeUndefined();
      // Write-back defaults off — AC-4 is opt-in, never implicit.
      expect(res.data.writeBackEnabled).toBe(false);
    }
  });

  it("accepts a GitLab connection with a self-managed baseUrl", () => {
    const res = connectIntegrationInput.safeParse({
      provider: "gitlab",
      secretId: "sec_1",
      baseUrl: "https://gitlab.internal.example.com",
    });
    expect(res.success).toBe(true);
  });

  it("accepts a provider id it has never heard of, and refuses one that is not an id", () => {
    // Whether a provider is *installed* is the registry's question, answered where the driver is
    // resolved — this schema's job is only that the id could name one. Deciding it here would
    // put the list of installed providers back into contracts, which is what F21 removed.
    expect(
      connectIntegrationInput.safeParse({ provider: "gitea", secretId: "sec_1" }).success,
    ).toBe(true);
    expect(
      connectIntegrationInput.safeParse({ provider: "Bit Bucket", secretId: "sec_1" }).success,
    ).toBe(false);
  });

  it("rejects a baseUrl that is not a URL", () => {
    const res = connectIntegrationInput.safeParse({
      provider: "github",
      secretId: "sec_1",
      baseUrl: "not-a-url",
    });
    expect(res.success).toBe(false);
  });

  it("never accepts a token value — only a secretId reference (Principle IV)", () => {
    // There is no "token" or "value" field on this schema at all; passing one is simply an
    // unrecognised key that Zod strips, proving the shape cannot carry a credential in place.
    const res = connectIntegrationInput.safeParse({
      provider: "github",
      secretId: "sec_1",
      token: "ghp_shouldNotExist",
    });
    expect(res.success && "token" in res.data).toBe(false);
  });
});

describe("importIssuesInput (issue #15 AC-2)", () => {
  it("accepts a repository id and a non-empty list of external ids", () => {
    const res = importIssuesInput.safeParse({ repositoryId: "repo_1", externalIds: ["101"] });
    expect(res.success).toBe(true);
  });

  it("rejects an empty externalIds list — nothing to import is not a valid import", () => {
    const res = importIssuesInput.safeParse({ repositoryId: "repo_1", externalIds: [] });
    expect(res.success).toBe(false);
  });
});

describe("createTaskInput", () => {
  const validTask = {
    issueId: "issue_1",
    title: "Fix the sensor driver",
    agentProfileId: "agent_1",
    executorProfileId: "exec_1",
    repositories: [{ repositoryId: "repo_1" }],
  };

  it("accepts a valid task (baseRef optional)", () => {
    const res = createTaskInput.safeParse(validTask);
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.repositories[0]?.baseRef).toBeUndefined();
  });

  it("accepts a task with an explicit baseRef", () => {
    const res = createTaskInput.safeParse({
      ...validTask,
      repositories: [{ repositoryId: "repo_1", baseRef: "main" }],
    });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.repositories[0]?.baseRef).toBe("main");
  });

  it("rejects a task missing the required id field (issueId)", () => {
    const { issueId, ...withoutIssueId } = validTask;
    const res = createTaskInput.safeParse(withoutIssueId);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.path.join(".") === "issueId")).toBe(true);
    }
  });

  it("rejects an empty required id (idSchema min 1)", () => {
    const res = createTaskInput.safeParse({ ...validTask, repositories: [{ repositoryId: "" }] });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.path.join(".") === "repositories.0.repositoryId")).toBe(
        true,
      );
    }
  });

  /**
   * Multi-repository Tasks (issue #7 AC-1). The bounds and the duplicate refusal live in the
   * contract so a bad attachment list is refused at the boundary rather than by a unique index
   * three layers down, where nothing can say which entry was the duplicate.
   */
  it("accepts several repositories, each with its own base ref and branch", () => {
    const res = createTaskInput.safeParse({
      ...validTask,
      repositories: [
        { repositoryId: "repo_1", baseRef: "main", checkoutBranch: "feature/api" },
        { repositoryId: "repo_2", baseRef: "develop" },
      ],
    });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.repositories).toHaveLength(2);
  });

  it("refuses a Task attached to no repository at all", () => {
    // A Task with no attachment can never be launched: there is nowhere to make a worktree.
    const res = createTaskInput.safeParse({ ...validTask, repositories: [] });
    expect(res.success).toBe(false);
  });

  it("refuses more repositories than one unit of review can be", () => {
    const many = Array.from({ length: MAX_TASK_REPOSITORIES + 1 }, (_, i) => ({
      repositoryId: `repo_${i}`,
    }));
    expect(createTaskInput.safeParse({ ...validTask, repositories: many }).success).toBe(false);
  });

  it("refuses the same repository and branch attached twice", () => {
    // Both entries would derive the same branch, so this is one worktree asked for twice — the
    // unique index would refuse it, but only after the Task row had already been written.
    const res = createTaskInput.safeParse({
      ...validTask,
      repositories: [{ repositoryId: "repo_1" }, { repositoryId: "repo_1" }],
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.message.includes("attached twice"))).toBe(true);
    }
  });

  it("accepts the same repository twice on two different branches (parity row 13)", () => {
    const res = createTaskInput.safeParse({
      ...validTask,
      repositories: [
        { repositoryId: "repo_1", checkoutBranch: "feature/a" },
        { repositoryId: "repo_1", checkoutBranch: "feature/b" },
      ],
    });
    expect(res.success).toBe(true);
  });

  it.each([
    ["an option-looking ref", "--upload-pack=touch/pwned"],
    ["a revision range", "main/../HEAD"],
    ["whitespace", "my branch"],
    ["a control character", "main\u0000"],
  ])("refuses %s as a base ref, before git ever sees it", (_label, baseRef) => {
    const res = createTaskInput.safeParse({
      ...validTask,
      repositories: [{ repositoryId: "repo_1", baseRef }],
    });
    expect(res.success).toBe(false);
  });

  it("refuses a checkout branch that could be read as a git option", () => {
    const res = createTaskInput.safeParse({
      ...validTask,
      repositories: [{ repositoryId: "repo_1", checkoutBranch: "-B" }],
    });
    expect(res.success).toBe(false);
  });
});

describe("setTaskRepositoriesInput", () => {
  it("carries the whole replacement set, not a delta", () => {
    const res = setTaskRepositoriesInput.safeParse({
      taskId: "task_1",
      repositories: [{ repositoryId: "repo_1" }, { repositoryId: "repo_2" }],
    });
    expect(res.success).toBe(true);
    if (res.success)
      expect(res.data.repositories.map((r) => r.repositoryId)).toEqual(["repo_1", "repo_2"]);
  });

  it("applies the same bounds as create, so neither path can write an unrunnable Task", () => {
    expect(setTaskRepositoriesInput.safeParse({ taskId: "task_1", repositories: [] }).success).toBe(
      false,
    );
  });

  it("refuses an entry that spells out the branch another entry would derive", () => {
    // The Task id is an input here, so the derived name is fully predictable to the caller:
    // `[{ repo }, { repo, checkoutBranch: <derived> }]` is one attachment written two ways.
    // Comparing the omitted branch as a key of its own let the pair through to the unique index,
    // where the refusal arrived as SQLite's constraint text inside a 500.
    const res = setTaskRepositoriesInput.safeParse({
      taskId: "task_1",
      repositories: [
        { repositoryId: "repo_1" },
        { repositoryId: "repo_1", checkoutBranch: taskCheckoutBranch("task_1") },
      ],
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      const issue = res.error.issues.find((i) => i.message.includes("attached twice"));
      // The path names the entry at fault, which is the whole reason to refuse it here.
      expect(issue?.path).toEqual(["repositories", 1, "repositoryId"]);
    }
  });

  it("still accepts the derived branch named on a repository attached only once", () => {
    const res = setTaskRepositoriesInput.safeParse({
      taskId: "task_1",
      repositories: [
        { repositoryId: "repo_1", checkoutBranch: taskCheckoutBranch("task_1") },
        { repositoryId: "repo_2" },
      ],
    });
    expect(res.success).toBe(true);
  });
});

describe("connectRepositoryInput superRefine", () => {
  it("rejects a remote_url whose location is not a git URL", () => {
    const res = connectRepositoryInput.safeParse({
      name: "gatecontrol",
      source: "remote_url",
      location: "/home/user/not-a-url",
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      const issue = res.error.issues.find((i) => i.path.join(".") === "location");
      expect(issue?.message).toBe("remote_url location must be a git URL");
    }
  });

  it("accepts a remote_url with an https git URL", () => {
    const res = connectRepositoryInput.safeParse({
      name: "gatecontrol",
      source: "remote_url",
      location: "https://github.com/acme/gatecontrol.git",
    });
    expect(res.success).toBe(true);
  });

  it("accepts a remote_url with an scp-style git@ URL", () => {
    const res = connectRepositoryInput.safeParse({
      name: "gatecontrol",
      source: "remote_url",
      location: "git@github.com:acme/gatecontrol.git",
    });
    expect(res.success).toBe(true);
  });

  it("accepts local_path with any (non-URL) location", () => {
    const res = connectRepositoryInput.safeParse({
      name: "local repo",
      source: "local_path",
      location: "/home/user/dev/gatecontrol",
    });
    expect(res.success).toBe(true);
  });
});

/**
 * `request_changes` is no longer gated on feedback. The Task page dropped its feedback panel, so a
 * schema that refused the decision without text would have made "Request changes" un-submittable
 * from the only UI that sends it. The field survives — it is what reaches the agent as
 * `pendingFeedback` on the next round — but as an option for callers who have something to say,
 * not a precondition for the ones who do not.
 */
describe("reviewDecisionInput", () => {
  it("accepts request_changes with no feedback at all", () => {
    const res = reviewDecisionInput.safeParse({
      sessionId: "sess_1",
      decision: "request_changes",
    });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.feedback).toBeUndefined();
    }
  });

  it("accepts request_changes with whitespace-only feedback", () => {
    const res = reviewDecisionInput.safeParse({
      sessionId: "sess_1",
      decision: "request_changes",
      feedback: "   ",
    });
    expect(res.success).toBe(true);
  });

  it("round-trips feedback when a caller supplies it", () => {
    const res = reviewDecisionInput.safeParse({
      sessionId: "sess_1",
      decision: "request_changes",
      feedback: "Please add error handling around the network call.",
    });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.feedback).toBe("Please add error handling around the network call.");
    }
  });

  it("accepts approve without feedback", () => {
    const res = reviewDecisionInput.safeParse({
      sessionId: "sess_1",
      decision: "approve",
    });
    expect(res.success).toBe(true);
  });
});

describe("setSecretInput", () => {
  it("accepts a valid api_key secret", () => {
    const res = setSecretInput.safeParse({
      name: "anthropic-key",
      kind: "api_key",
      value: "sk-ant-xxxxx",
    });
    expect(res.success).toBe(true);
  });

  it("accepts a subscription_token secret", () => {
    const res = setSecretInput.safeParse({
      name: "claude-sub",
      kind: "subscription_token",
      value: "token-value",
    });
    expect(res.success).toBe(true);
  });

  it("rejects an unknown secret kind", () => {
    const res = setSecretInput.safeParse({
      name: "bad",
      kind: "password",
      value: "x",
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.path.join(".") === "kind")).toBe(true);
    }
  });

  it("rejects an empty value", () => {
    const res = setSecretInput.safeParse({
      name: "empty",
      kind: "api_key",
      value: "",
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.path.join(".") === "value")).toBe(true);
    }
  });

  it("rejects a missing name", () => {
    const res = setSecretInput.safeParse({ kind: "api_key", value: "x" });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.path.join(".") === "name")).toBe(true);
    }
  });
});

describe("taskEventSchema discriminated union", () => {
  it("parses a valid stdout event", () => {
    const res = taskEventSchema.safeParse({
      kind: "stdout",
      taskId: "task_1",
      sessionId: "sess_1",
      seq: 0,
      text: "compiling...",
      channel: "system",
    });
    expect(res.success).toBe(true);
    if (res.success && res.data.kind === "stdout") {
      expect(res.data.text).toBe("compiling...");
      expect(res.data.seq).toBe(0);
      // The channel is required: a frame that does not say what it is would leave the terminal
      // guessing again, which is the thing widening the union was meant to end.
      expect(res.data.channel).toBe("system");
    }
  });

  it("parses a valid status event", () => {
    const res = taskEventSchema.safeParse({
      kind: "status",
      taskId: "task_1",
      state: "running",
      at: "2026-08-17T12:00:00.000Z",
    });
    expect(res.success).toBe(true);
    if (res.success && res.data.kind === "status") {
      expect(res.data.state).toBe("running");
    }
  });

  it("rejects an unknown event kind", () => {
    const res = taskEventSchema.safeParse({
      kind: "heartbeat",
      taskId: "task_1",
    });
    expect(res.success).toBe(false);
  });

  it("rejects a stdout event with a non-integer seq", () => {
    const res = taskEventSchema.safeParse({
      kind: "stdout",
      taskId: "task_1",
      sessionId: "sess_1",
      seq: 1.5,
      text: "x",
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.path.join(".") === "seq")).toBe(true);
    }
  });

  it("rejects a status event with an invalid datetime", () => {
    const res = taskEventSchema.safeParse({
      kind: "status",
      taskId: "task_1",
      state: "done",
      at: "not-a-date",
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.path.join(".") === "at")).toBe(true);
    }
  });

  it("rejects a status event with an invalid task state", () => {
    const res = taskEventSchema.safeParse({
      kind: "status",
      taskId: "task_1",
      state: "paused",
      at: "2026-08-17T12:00:00.000Z",
    });
    expect(res.success).toBe(false);
  });

  it("carries the agent's todo list, addressed like every other row of the log", () => {
    // The frame needs `sessionId` and `seq` as much as a tool call does: it is projected from a
    // stored event, and a reconnecting client drops what it has already seen by `seq`.
    const res = taskEventSchema.safeParse({
      kind: "todos",
      taskId: "task_1",
      sessionId: "sess_1",
      seq: 12,
      items: [
        { content: "Record the todo list", status: "in_progress", activeForm: "Recording it" },
        { content: "Show it on the Task page", status: "pending" },
      ],
    });
    expect(res.success).toBe(true);
    if (res.success && res.data.kind === "todos") {
      expect(res.data.items).toHaveLength(2);
      expect(res.data.items[0]?.activeForm).toBe("Recording it");
      // Optional, and absent rather than defaulted: an agent that offers no present-tense form
      // is not the same as one that offers an empty string.
      expect(res.data.items[1]?.activeForm).toBeUndefined();
    }
  });

  it("rejects a todo item whose status is not one a renderer can draw", () => {
    const res = taskEventSchema.safeParse({
      kind: "todos",
      taskId: "task_1",
      sessionId: "sess_1",
      seq: 1,
      items: [{ content: "Ship it", status: "blocked" }],
    });
    expect(res.success).toBe(false);
  });
});

/**
 * The allowlist that decides which files are copied into an agent's worktree (issue #52). Every
 * rejection here is a path jail expressed as a type: a pattern that cannot name a file outside
 * the repository cannot copy a credential out of one.
 */
describe("setupFilePatternSchema (issue #52 AC-6)", () => {
  it("accepts the patterns the feature exists for", () => {
    for (const pattern of [".env", ".env.*", "config/local.json", "apps/**/.env.local"]) {
      expect(setupFilePatternSchema.safeParse(pattern).success).toBe(true);
    }
  });

  it("trims surrounding whitespace rather than matching on it", () => {
    const res = setupFilePatternSchema.safeParse("  .env  ");
    expect(res.success).toBe(true);
    if (res.success) expect(res.data).toBe(".env");
  });

  it("rejects an absolute path", () => {
    expect(setupFilePatternSchema.safeParse("/etc/shadow").success).toBe(false);
  });

  it("rejects a pattern that climbs out of the repository", () => {
    expect(setupFilePatternSchema.safeParse("../../.ssh/id_rsa").success).toBe(false);
    expect(setupFilePatternSchema.safeParse("config/../../.env").success).toBe(false);
  });

  it("keeps a filename that merely starts with dots", () => {
    // `..env` is a legitimate filename; only a `..` *segment* escapes.
    expect(setupFilePatternSchema.safeParse("..env").success).toBe(true);
  });

  it("rejects a pattern git would read as pathspec magic", () => {
    expect(setupFilePatternSchema.safeParse(":(top)/etc/passwd").success).toBe(false);
  });

  it("rejects a pattern that could be read as an option", () => {
    expect(setupFilePatternSchema.safeParse("--output=/tmp/x").success).toBe(false);
  });

  it("rejects an embedded newline or NUL", () => {
    expect(setupFilePatternSchema.safeParse(".env\n.ssh/id_rsa").success).toBe(false);
    expect(setupFilePatternSchema.safeParse(".env\0").success).toBe(false);
  });

  it("caps the list — an allowlist needing fifty entries is not one", () => {
    const tooMany = Array.from({ length: MAX_SETUP_FILE_PATTERNS + 1 }, (_, i) => `.env.${i}`);
    expect(setupFilePatternsSchema.safeParse(tooMany).success).toBe(false);
    expect(setupFilePatternsSchema.safeParse(tooMany.slice(0, -1)).success).toBe(true);
    expect(setupFilePatternsSchema.safeParse([]).success).toBe(true);
  });
});

/**
 * The todo item both the wire frame and the durable log carry (`todoItemSchema`).
 *
 * Its bounds are what stop an agent's plan from becoming an unbounded blob in a record that
 * outlives the run, so they are pinned here rather than left to the producer that applies them.
 */
describe("todoItemSchema", () => {
  it("refuses an item with nothing written on it", () => {
    expect(todoItemSchema.safeParse({ content: "", status: "pending" }).success).toBe(false);
  });

  it("refuses an item longer than a line of a plan", () => {
    expect(todoItemSchema.safeParse({ content: "x".repeat(501), status: "pending" }).success).toBe(
      false,
    );
    expect(
      todoItemSchema.safeParse({
        content: "ok",
        status: "pending",
        activeForm: "y".repeat(501),
      }).success,
    ).toBe(false);
  });
});
