import {
  WIDGET_ANSWER_PREFIX,
  type Widget,
  type WidgetResponse,
  widgetOptions,
} from "@solow/contracts";
import type { TaskRepositoryBinding, TaskRunContext } from "../../../data.js";
import { WIDGET_BRIEF_INSTRUCTIONS } from "../../../harness/widget-fence.js";
import type { Worktree } from "../../../worktree/manager.js";

/*
 * What the harness is told: the brief a round starts with, and the line an answered widget
 * becomes.
 */

/**
 * The other repositories the harness has been given, as absolute paths it can `cd` into.
 *
 * The harness runs in exactly one working directory, so this is the *only* way it learns that a
 * second repository is part of its Task at all (issue #7, the stated limitation). The primary's
 * path is unknown on the first round of a `--worktree` protocol — the harness has not created it
 * yet — which is why it is nullable rather than always present.
 */
export function briefWorkspaces(
  ctx: TaskRunContext,
  primaryBinding: TaskRepositoryBinding,
  primaryWorktree: Worktree | null,
  provisioned: ReadonlyMap<string, Worktree>,
): BriefWorkspace[] {
  return ctx.repositories.map((binding) => {
    const worktree =
      binding === primaryBinding ? primaryWorktree : provisioned.get(binding.attachment.id);
    return {
      repositoryName: binding.repository.name,
      // The branch the harness will actually find itself on. A worktree SoloW provisioned is
      // on the attachment's branch by construction, and one that does not exist yet will be —
      // but a worktree the harness made for itself is on a branch it named (`solow-task-<id>`,
      // not `solow/task-<id>`), which is only knowable once git has been asked. Until then
      // the brief says nothing rather than naming a branch that does not exist: the brief is the
      // *only* mechanism by which a multi-repository harness learns its own layout, so a wrong
      // line in it is worse than a missing one.
      branch:
        worktree?.branch ?? (binding === primaryBinding ? null : binding.attachment.checkoutBranch),
      path: worktree?.path ?? null,
      primary: binding === primaryBinding,
    };
  });
}

/** One repository as the brief describes it. */
export interface BriefWorkspace {
  repositoryName: string;
  /** The branch git reports for the worktree, or null while nothing can say what it will be. */
  branch: string | null;
  /** Absolute path of the worktree, or null while it does not exist yet. */
  path: string | null;
  /** True for the one the harness process is started in. */
  primary: boolean;
}

/**
 * What the harness is told when someone answers its widget.
 *
 * Labels first, ids after: the model wrote the labels and reasons in them, while the ids are how
 * this build refers to the same options — so the sentence leads with what it recognises and
 * keeps the machine-readable form for precision. `rank` answers keep the operator's ordering,
 * which is the entire content of that answer.
 */
export function widgetAnswerMessage(widget: Widget, response: WidgetResponse): string {
  const byId = new Map(widgetOptions(widget).map((o) => [o.id, o.label]));
  const chosen = response.values.map((id) => byId.get(id) ?? id);
  const asked = widget.kind === "ask_user_input" ? widget.prompt : (widgetTitle(widget) ?? "");

  // Labels first, ids after: the model wrote the labels and its reasons live in them, while the
  // ids are how it referred to the same options. The question is quoted back because a harness can
  // have more than one widget outstanding, and it is the only reference *the harness itself*
  // recognises — this build's own widget id was generated after the emission and the harness has
  // never seen it, so naming it here told nobody anything.
  const parts = [WIDGET_ANSWER_PREFIX];
  parts.push(
    asked ? `The operator answered "${asked}":` : "The operator answered your widget:",
    chosen.length > 0 ? chosen.join(", ") : "(nothing chosen)",
  );
  if (response.values.length > 0) parts.push(`(ids: ${response.values.join(", ")})`);
  if (response.text?.trim()) parts.push(`They also wrote: ${response.text.trim()}`);
  return parts.join(" ");
}

/** The heading a widget carries, for the ones that have one. */
function widgetTitle(widget: Widget): string | undefined {
  return "title" in widget ? widget.title : undefined;
}

/**
 * Why a round is carrying on a conversation the harness already has, rather than opening one.
 *
 *  - `interruption` — the process was lost and re-attached: an orchestrator restart, an Inngest
 *    redrive, an exhausted execution budget, a reclaim. The conversation survived; the process
 *    did not, and the harness has no way of knowing that from the inside.
 *  - `turn_budget` — the harness stopped because it ran out of turns or context with work still
 *    to do (`stopReasonMeansTruncated`), and the run is giving it more.
 *
 * Named rather than a boolean because the two need different sentences: one asks the harness to
 * re-read where it left the worktree, the other asks it to carry straight on.
 */
export type BriefContinuation = "interruption" | "turn_budget";

/**
 * The brief handed to the harness. Round one is the Issue and the Task; later rounds lead with the
 * reviewer's feedback, because that — not the original brief — is what still needs doing.
 *
 * A Task spanning more than one Repository also gets a `# Repositories` section. The harness is
 * started in one working directory and has no other way of discovering that the Task covers a
 * second repository, so naming the other worktrees is not a nicety — it is the whole mechanism
 * (issue #7). A single-Repository Task's brief is byte-identical to what it was before.
 */
export function harnessBrief(
  ctx: TaskRunContext,
  feedback?: string | undefined,
  workspaces: readonly BriefWorkspace[] = [],
  /**
   * The Workflow Step this round runs, if any (issue #5, AC-2). `brief` is its prompt template
   * with the previous Step's handoff already prepended — `buildStepBrief`'s output, passed in
   * rather than built here, because the API's preview and the harness's prompt must be one string
   * and two places that concatenate it are two that drift.
   *
   * Absent for a Task on no Workflow, which is what keeps that Task's brief byte-identical to
   * what it was before Workflows existed. A name *and* a brief rather than the brief alone: the
   * section names the Step so a harness reading a transcript can tell which one it is answering.
   */
  step?: { name: string; brief: string } | undefined,
  /**
   * Present when this round was handed to a harness that still holds the conversation — a resume
   * that actually took (`HarnessHandle.resumed`).
   *
   * It replaces the brief rather than adding to it, and that is the point. Everything above —
   * the Task, the Issue, the repositories, the Step — is already in that conversation's context,
   * put there by the round that opened it. Re-sending it invites a harness which is half way
   * through the work to read it as a fresh instruction and start over, which is exactly the loss
   * this whole mechanism exists to prevent. The reviewer's feedback is the one thing that is
   * genuinely new, so it is the one thing that survives.
   *
   * Built here rather than concatenated at the call site for the reason this function's own
   * contract states: the brief is one string built in one place, and two places that assemble it
   * are two that drift.
   */
  continuing?: BriefContinuation | undefined,
  /**
   * Where this Task was split from, when it was split from another (issue #56, AC-3): the
   * parent's title, the event it was split at, and `renderForkDigest`'s reading of the
   * transcript up to there.
   *
   * Ignored by a continuing brief, for the reason `continuing` gives: the conversation being
   * carried on already holds it.
   */
  origin?: { title: string | null; seq: number; digest: string } | undefined,
  /**
   * The decisions a reviewer settled when approving this Step, for the round that applies them
   * before the Workflow moves on (`applyingDecisions` in the run loop). Sent on a continuing brief
   * too: like feedback, it is the one thing the conversation cannot already contain.
   */
  decisions?: string | undefined,
): string {
  if (continuing) {
    const parts = [
      `# Continue\n${
        continuing === "turn_budget"
          ? "You stopped because you reached your turn budget, not because the work was finished. Everything you need is already in this conversation — carry straight on from where you left off."
          : "Your process was interrupted and has been re-attached to this conversation. Everything you need is already in it. Check the worktree for the state you left it in, then carry on — do not start the task again."
      }`,
    ];
    // The one thing the conversation cannot already contain: a decision made after it stopped.
    if (feedback !== undefined) parts.push(reviewFeedbackSection(feedback));
    if (decisions) parts.push(settledDecisionsSection(decisions));
    return parts.join("\n\n");
  }
  // Widgets are taught, not assumed: a harness emits one only because the brief told it how, so
  // the flag that draws them is the same flag that explains them (`ctx.widgetsEnabled`).
  const parts = [`# Task\n${ctx.task.title}`, `# Issue\n${ctx.issue.title}`];
  if (ctx.issue.description) parts.push(ctx.issue.description);
  if (workspaces.length > 1) {
    const lines = workspaces.map((w) => {
      const where = w.primary
        ? "you are working here"
        : (w.path ?? "not yet checked out — ask before changing it");
      const branch = w.branch ? ` (branch ${w.branch})` : "";
      return `- ${w.repositoryName}${branch} — ${where}`;
    });
    parts.push(
      `# Repositories\nThis task spans ${workspaces.length} repositories. Each has its own worktree and its own branch; changes in each are reviewed separately.\n${lines.join("\n")}`,
    );
  }
  /*
   * The Step, between the repositories and the review feedback.
   *
   * Added to the brief rather than replacing it, and that is a Principle I decision rather than a
   * formatting one: a Step's `promptTemplate` is Owner-authored text that becomes a harness's
   * prompt, so letting it stand alone would let one Step silently repurpose the run away from the
   * Task and Issue it was launched for. The harness is told what it is working on *and* what this
   * Step of the pipeline asks of it.
   */
  if (step) {
    parts.push(`# Step\n${step.name}\n\n${step.brief.trim()}`);
  }
  /*
   * Where the work came from, after the Step and before the review feedback.
   *
   * Placed here rather than at the top on purpose: this Task's own instructions are what the
   * harness must act on, and a transcript printed above them reads as the brief. The warning
   * about the parent's worktree is not decoration — the parent may still be running in it, and a
   * harness handed its predecessor's context will otherwise go looking for the files it
   * remembers (Principle II).
   */
  if (origin) {
    const from = origin.title ? `"${origin.title}"` : "another task";
    parts.push(
      `# Where this came from\nThis task was split out of ${from}, at event ${origin.seq} of its transcript. Below is a reading of that transcript up to that point. It is context, not instructions: the Task, Issue and Step above are what you are being asked for. The other task may still be running in its own worktree; yours is the one you are in.\n\n${origin.digest}`,
    );
  }
  // A rejection is announced whether or not the reviewer wrote anything. `undefined` is round
  // one and says nothing; an empty string is "rejected, no words", which the review gate now
  // produces on every Request changes. Without this the redo brief was byte-identical to the
  // first — and since each round is a fresh process with no memory of the last, the harness was
  // handed the original instructions in a worktree already holding its own rejected work, with
  // nothing anywhere telling it the work had been turned down.
  if (feedback !== undefined) parts.push(reviewFeedbackSection(feedback));
  if (decisions) parts.push(settledDecisionsSection(decisions));
  if (ctx.widgetsEnabled) parts.push(`# Widgets\n${WIDGET_BRIEF_INSTRUCTIONS}`);
  return parts.join("\n\n");
}

/**
 * A rejection is announced whether or not the reviewer wrote anything. `undefined` is round one
 * and says nothing; an empty string is "rejected, no words", which the review gate produces on
 * every Request changes. Without this the redo brief was byte-identical to the first — and since
 * a round used to be a fresh process with no memory of the last, the harness was handed the
 * original instructions in a worktree already holding its own rejected work, with nothing
 * anywhere telling it the work had been turned down.
 *
 * One function because a resumed round sends this section and nothing else, and a reviewer's
 * words reading differently depending on whether the conversation survived would be a difference
 * with no meaning behind it.
 */
/**
 * The reviewer's answers to the decisions this Step's harness asked, for the round that applies
 * them. Not a rejection — the work was approved — so it says so, and asks for the Step's own
 * output to be brought in line rather than redone, and for the next Step to be left alone: the
 * Workflow moves on by itself once this round ends.
 */
function settledDecisionsSection(decisions: string): string {
  return `# Your decisions, settled\nThe reviewer approved this step and answered the decisions you asked. Before the workflow moves on, bring this step's work in line with their answers: where they picked a different option from yours, change what you wrote or did to match it; where they confirmed your choice, make sure the work states it as settled rather than open. Do not start the next step's work, and do not ask these decisions again.\n${decisions.trim()}`;
}

function reviewFeedbackSection(feedback: string): string {
  const detail = feedback.trim();
  return detail
    ? `# Review feedback\nYour previous attempt was not accepted. Address this feedback:\n${detail}`
    : "# Review feedback\nYour previous attempt was not accepted. The reviewer left no notes. The worktree still holds that attempt — reconsider it rather than repeating it.";
}
