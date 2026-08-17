import { describe, it, expect } from "bun:test";
import {
  createIssueInput,
  createTaskInput,
  connectRepositoryInput,
  reviewDecisionInput,
  setSecretInput,
  taskEventSchema,
} from "./index.js";

describe("createIssueInput", () => {
  it("accepts a valid issue", () => {
    const res = createIssueInput.safeParse({
      title: "Broken gate sensor",
      description: "The east gate sensor stopped reporting.",
    });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.title).toBe("Broken gate sensor");
      expect(res.data.description).toBe("The east gate sensor stopped reporting.");
    }
  });

  it("accepts an issue without a description (optional)", () => {
    const res = createIssueInput.safeParse({ title: "No description" });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.description).toBeUndefined();
  });

  it("rejects an empty title", () => {
    const res = createIssueInput.safeParse({ title: "" });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.path.join(".") === "title")).toBe(true);
    }
  });

  it("rejects a title longer than 200 chars", () => {
    const res = createIssueInput.safeParse({ title: "x".repeat(201) });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.path.join(".") === "title")).toBe(true);
    }
  });

  it("accepts a title of exactly 200 chars (boundary)", () => {
    const res = createIssueInput.safeParse({ title: "x".repeat(200) });
    expect(res.success).toBe(true);
  });
});

describe("createTaskInput", () => {
  const validTask = {
    issueId: "issue_1",
    title: "Fix the sensor driver",
    agentProfileId: "agent_1",
    executorProfileId: "exec_1",
    repositoryId: "repo_1",
  };

  it("accepts a valid task (baseRef optional)", () => {
    const res = createTaskInput.safeParse(validTask);
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.baseRef).toBeUndefined();
  });

  it("accepts a task with an explicit baseRef", () => {
    const res = createTaskInput.safeParse({ ...validTask, baseRef: "main" });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.baseRef).toBe("main");
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
    const res = createTaskInput.safeParse({ ...validTask, repositoryId: "" });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.path.join(".") === "repositoryId")).toBe(true);
    }
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

describe("reviewDecisionInput superRefine", () => {
  it("rejects request_changes without feedback", () => {
    const res = reviewDecisionInput.safeParse({
      sessionId: "sess_1",
      decision: "request_changes",
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      const issue = res.error.issues.find((i) => i.path.join(".") === "feedback");
      expect(issue?.message).toBe("feedback is required when requesting changes");
    }
  });

  it("rejects request_changes with whitespace-only feedback", () => {
    const res = reviewDecisionInput.safeParse({
      sessionId: "sess_1",
      decision: "request_changes",
      feedback: "   ",
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.path.join(".") === "feedback")).toBe(true);
    }
  });

  it("accepts request_changes with real feedback", () => {
    const res = reviewDecisionInput.safeParse({
      sessionId: "sess_1",
      decision: "request_changes",
      feedback: "Please add error handling around the network call.",
    });
    expect(res.success).toBe(true);
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
    });
    expect(res.success).toBe(true);
    if (res.success && res.data.kind === "stdout") {
      expect(res.data.text).toBe("compiling...");
      expect(res.data.seq).toBe(0);
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
});
