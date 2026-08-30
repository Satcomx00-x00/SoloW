"use client";

import type {
  CreatedProviderIssueDto,
  IssueCreateSupport,
  IssueLinkType,
  RepositoryAssigneeDto,
  RepositoryLabelDto,
  RepositoryMilestoneDto,
} from "@solow/contracts";
import {
  CalendarDays,
  Check,
  ChevronsUpDown,
  EyeOff,
  Link2,
  Milestone as MilestoneIcon,
  Tags,
  Timer,
  UserPlus,
  Weight,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { WHOLE_PAGE } from "@/lib/paged";
import { cn } from "@/lib/utils";
import { trpc } from "@/trpc/react";
import { groupLabelsByCategory, MarkdownField } from "./issue-authoring";

/**
 * Flow A of the create workflow (spec F23a Part 1): originate an Issue **on the provider** from
 * inside a Project, then attach the mirrored row to it.
 *
 * Two modals, one piece of form state. "Where" picks the repository; "Compose" fills it in. The
 * state lives here in the parent rather than per-step, which is the whole reason ← Back can be a
 * cheap `setStep` — nothing typed is stored inside the step it was typed in, so stepping away from
 * it cannot drop it (the F23a error rule applied to navigation, not just to a server refusal).
 *
 * Compose is a GitHub-shaped two-column form: the *content* (title, description) on the left and a
 * *metadata sidebar* (assignees, labels, milestone, parent epic) on the right. Each sidebar control
 * is a real provider-backed picker — the same reads the project table's own cells use — so what is
 * offered here is exactly what the provider will accept, never a free-typed guess it might reject.
 */

const TITLE_MAX = 300;

/**
 * The repositories a provider Issue can actually be created in.
 *
 * A purely local-path Repository has `integrationId === null` (`repositoryDto`) and no provider to
 * POST to, so it is filtered out here rather than offered and rejected. This reads the *workspace*
 * repository list, not `project.repositories`: that per-Project list carries no provider metadata
 * and is empty for a mirrored Project (its membership comes from a sync) — the very Projects whose
 * whole point is originating provider Issues. `projectId` on the mutation is what ties the new
 * Issue back to this Project; the repository only has to be one the token can write to.
 */
function providerBackedRepos<T extends { integrationId: string | null }>(repos: readonly T[]): T[] {
  return repos.filter((r) => r.integrationId !== null);
}

type Step = "where" | "compose";

/** One row of the Linked items control, before it becomes a `links` entry on the mutation. */
interface IssueLinkDraft {
  issueNumber: number;
  type: IssueLinkType;
  /** Kept only so a chosen row can name the issue rather than showing a bare number. */
  title: string;
}

/** How each link type is spelled where a person reads it. */
const LINK_TYPE_LABEL: Record<IssueLinkType, string> = {
  relates_to: "Relates to",
  blocks: "Blocks",
  is_blocked_by: "Is blocked by",
};

export function CreateIssueDialog({
  projectId,
  /**
   * Whether this Project's provider declares `issueCreates.epics` — decided against the manifest
   * by the caller (never against the provider's name, Decision 0016). Gates the Parent-epic
   * control: a GitHub Issue simply never offers one.
   */
  epicsSupported,
  open,
  onOpenChange,
  onCreated,
}: {
  projectId: string;
  epicsSupported: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (created: CreatedProviderIssueDto) => void;
}) {
  const utils = trpc.useUtils();
  const repos = trpc.repository.list.useQuery({ ...WHOLE_PAGE }, { enabled: open });
  const eligible = useMemo(() => providerBackedRepos(repos.data?.items ?? []), [repos.data]);

  const [step, setStep] = useState<Step>("where");
  const [repositoryId, setRepositoryId] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [assignees, setAssignees] = useState<string[]>([]);
  const [labels, setLabels] = useState<string[]>([]);
  const [milestone, setMilestone] = useState("");
  const [groupRef, setGroupRef] = useState("");
  const [parentEpicId, setParentEpicId] = useState("");
  // The capability-gated five (user request 2026-08-30). Held as strings where the control is a
  // text input, so a half-typed value is never coerced to 0 or NaN on its way through state.
  const [dueDate, setDueDate] = useState("");
  const [weight, setWeight] = useState("");
  const [confidential, setConfidential] = useState(false);
  const [timeEstimate, setTimeEstimate] = useState("");
  const [links, setLinks] = useState<IssueLinkDraft[]>([]);

  // A fresh dialog every open: form state seeded once at mount would carry a previous attempt's
  // title into the next New issue, which is the leak `issue-form-dialog` resets for the same reason.
  useEffect(() => {
    if (!open) return;
    setStep("where");
    setRepositoryId("");
    setTitle("");
    setDescription("");
    setAssignees([]);
    setLabels([]);
    setMilestone("");
    setGroupRef("");
    setParentEpicId("");
    setDueDate("");
    setWeight("");
    setConfidential(false);
    setTimeEstimate("");
    setLinks([]);
  }, [open]);

  // "Skip Modal 1 when there is exactly one choice" (F23a Flow A): pre-select the sole eligible
  // repository and open straight into Compose. Guarded on `repositoryId` so it fires once, when the
  // list first resolves, and never fights a choice the operator then makes.
  useEffect(() => {
    if (!open || repositoryId) return;
    const only = eligible.length === 1 ? eligible[0] : undefined;
    if (only) {
      setRepositoryId(only.id);
      setStep("compose");
    }
  }, [open, eligible, repositoryId]);

  const selectedRepo = eligible.find((r) => r.id === repositoryId);
  const onCompose = open && step === "compose" && repositoryId.length > 0;

  /**
   * What the chosen Repository's provider can hold beyond the universal fields — asked of the
   * **manifest**, never of the provider's name (Decision 0016), and keyed on the *repository's*
   * provider rather than the Project's for the same reason the epic picker is: the repository is
   * where the POST lands, and the two can disagree. Absent flag reads as `false`, so a provider
   * that has not answered offers no control rather than one its driver would refuse.
   */
  const manifests = trpc.integration.providers.useQuery({}, { enabled: onCompose, retry: false });
  const creates = useMemo(() => {
    const manifest = manifests.data?.find((m) => m.id === selectedRepo?.provider);
    return manifest?.issueCreates;
  }, [manifests.data, selectedRepo?.provider]);
  const providerLabels = trpc.repository.listLabels.useQuery(
    { repositoryId },
    { enabled: onCompose },
  );
  const assignableUsers = trpc.repository.listAssignableUsers.useQuery(
    { repositoryId },
    { enabled: onCompose },
  );
  const milestones = trpc.repository.listMilestones.useQuery(
    { repositoryId },
    { enabled: onCompose },
  );

  // Epics hang off a *group* on the same Integration the chosen Repository lives on, so the Parent
  // picker follows the repository, not the Project — the two agree for a mirrored Project and the
  // repository is the authoritative one when they don't.
  const epicIntegrationId = selectedRepo?.integrationId ?? null;
  const showEpicPicker = epicsSupported && epicIntegrationId !== null;
  const groups = trpc.project.listGroups.useQuery(
    { integrationId: epicIntegrationId ?? "" },
    { enabled: onCompose && showEpicPicker },
  );
  // A single group is not a question — resolve `groupRef` to it so the epic list can load without a
  // pick nobody would make differently.
  useEffect(() => {
    if (!showEpicPicker || groupRef) return;
    const only = groups.data?.length === 1 ? groups.data[0] : undefined;
    if (only) setGroupRef(only.fullPath);
  }, [showEpicPicker, groups.data, groupRef]);
  const epics = trpc.project.listEpics.useQuery(
    { integrationId: epicIntegrationId ?? "", groupRef },
    { enabled: onCompose && showEpicPicker && groupRef.length > 0 },
  );

  const create = trpc.issue.createOnProvider.useMutation({
    onSuccess: (created) => {
      // The row is mirrored back through the ordinary reads (F23a Action 4/5): the project's items
      // gain a row and the Issue list gains the Issue, so both are invalidated — never a locally
      // patched copy, which would show the typed title rather than the provider's stored one.
      void utils.project.allItems.invalidate();
      void utils.issue.list.invalidate();
      onCreated?.(created);
      onOpenChange(false);
    },
  });

  const toggle = (set: (fn: (prev: string[]) => string[]) => void, value: string) =>
    set((prev) => (prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]));

  const submit = () => {
    if (!repositoryId || title.trim().length === 0) return;
    create.mutate({
      repositoryId,
      projectId,
      title,
      ...(description.trim().length > 0 ? { description } : {}),
      ...(assignees.length > 0 ? { assignees } : {}),
      ...(labels.length > 0 ? { labels } : {}),
      ...(milestone ? { milestone } : {}),
      // `undefined`, never `""`: the schema reads absent as "no parent", and an empty string is a
      // parent id the provider would reject.
      ...(parentEpicId ? { parentEpicId } : {}),
      // Each sent only when its control was both offered (the manifest said so) and filled in —
      // an untouched control must not send a value the operator never chose.
      ...(creates?.dueDate && dueDate ? { dueDate } : {}),
      ...(creates?.weight && weight.trim() !== "" ? { weight: Number(weight) } : {}),
      ...(creates?.confidential && confidential ? { confidential } : {}),
      ...(creates?.timeEstimate && timeEstimate.trim()
        ? { timeEstimate: timeEstimate.trim() }
        : {}),
      ...(creates?.links && links.length > 0
        ? { links: links.map(({ issueNumber, type }) => ({ issueNumber, type })) }
        : {}),
    });
  };

  const canSubmit = title.trim().length > 0 && repositoryId.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size={step === "compose" ? "xl" : "sm"}>
        {step === "where" ? (
          <>
            <DialogHeader>
              <DialogTitle>New issue · where</DialogTitle>
              <DialogDescription>
                Pick the repository to create it in. It is created on that repository&apos;s
                provider and mirrored back into this project.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              <Label htmlFor="create-issue-repository">Repository</Label>
              {repos.isPending ? (
                <p className="text-muted-foreground text-sm">Loading repositories…</p>
              ) : eligible.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  {/* The same reason the menu item states, restated where the operator arrived
                      anyway: no provider-backed repository, so nothing to POST an issue to. */}
                  This project has no provider-backed repository. Connect a GitHub or GitLab
                  repository first.
                </p>
              ) : (
                <ul className="max-h-72 divide-y overflow-y-auto rounded-md border">
                  {eligible.map((r) => (
                    <li key={r.id}>
                      <button
                        type="button"
                        className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/60 ${
                          r.id === repositoryId ? "bg-muted/60" : ""
                        }`}
                        onClick={() => setRepositoryId(r.id)}
                      >
                        <span className="min-w-0 flex-1 truncate">{r.name}</span>
                        {r.provider && (
                          <Badge variant="secondary" className="shrink-0">
                            {r.provider}
                          </Badge>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                type="button"
                disabled={repositoryId.length === 0}
                onClick={() => setStep("compose")}
              >
                Next →
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>New issue · compose</DialogTitle>
              <DialogDescription>
                {selectedRepo ? `On ${selectedRepo.name}.` : ""} What comes back is the
                provider&apos;s own copy, never the text typed here.
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_15rem]">
              {/* Content — the two fields SoloW actually authors before the provider takes over. */}
              <div className="min-w-0 space-y-4">
                <div className="grid gap-2">
                  <div className="flex items-baseline justify-between">
                    <Label htmlFor="create-issue-title">
                      Title <span className="text-destructive">*</span>
                    </Label>
                    <span
                      className={cn(
                        "text-2xs tabular-nums",
                        title.length > TITLE_MAX ? "text-destructive" : "text-muted-foreground/60",
                      )}
                    >
                      {title.length}/{TITLE_MAX}
                    </span>
                  </div>
                  <Input
                    id="create-issue-title"
                    value={title}
                    maxLength={TITLE_MAX}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="e.g. Gate motor stalls in cold weather"
                  />
                </div>
                <MarkdownField value={description} onChange={setDescription} />

                {create.error && (
                  <p className="text-destructive text-sm" role="alert">
                    {/* The provider's own words, kept here with the form intact (F23a error rule): a
                        rejected label or an assignee without access is fixed in place, not retyped. */}
                    {create.error.message}
                  </p>
                )}
              </div>

              {/* Metadata sidebar — every control a provider-backed picker, not a free-typed field. */}
              <aside className="space-y-3">
                <AssigneeField
                  users={assignableUsers.data ?? []}
                  loading={assignableUsers.isLoading}
                  error={assignableUsers.isError}
                  selected={assignees}
                  onToggle={(login) => toggle(setAssignees, login)}
                  onRetry={() => assignableUsers.refetch()}
                />
                <Separator />
                <LabelField
                  labels={providerLabels.data ?? []}
                  loading={providerLabels.isLoading}
                  error={providerLabels.isError}
                  selected={labels}
                  onToggle={(name) => toggle(setLabels, name)}
                  onRetry={() => providerLabels.refetch()}
                />
                <Separator />
                <MilestoneField
                  milestones={milestones.data ?? []}
                  loading={milestones.isLoading}
                  value={milestone}
                  onChange={setMilestone}
                />

                {/* Everything below is declared by the provider's manifest, never by its name
                    (Decision 0016) — on GitHub none of it renders, because its issues hold none
                    of it. `ProviderExtras` keeps that gating in one place. */}
                <ProviderExtras
                  creates={creates}
                  dueDate={dueDate}
                  onDueDate={setDueDate}
                  weight={weight}
                  onWeight={setWeight}
                  confidential={confidential}
                  onConfidential={setConfidential}
                  timeEstimate={timeEstimate}
                  onTimeEstimate={setTimeEstimate}
                  links={links}
                  onLinks={setLinks}
                  repositoryId={repositoryId}
                  enabled={onCompose}
                />

                {showEpicPicker && (
                  <>
                    <Separator />
                    <FieldShell icon={<MilestoneIcon aria-hidden />} label="Parent epic">
                      {/* GitLab-only, and rendered only because the manifest said so — the epic lives
                          on a group, so a group has to be resolved before its epics can be listed. */}
                      <Select value={groupRef} onValueChange={(v) => setGroupRef(v)}>
                        <SelectTrigger className="w-full" id="create-issue-group">
                          <SelectValue placeholder="Group" />
                        </SelectTrigger>
                        <SelectContent>
                          {(groups.data ?? []).map((g) => (
                            <SelectItem key={g.externalId} value={g.fullPath}>
                              {g.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Select
                        value={parentEpicId || "none"}
                        onValueChange={(v) => setParentEpicId(v === "none" ? "" : v)}
                        disabled={groupRef.length === 0}
                      >
                        <SelectTrigger className="w-full" id="create-issue-epic">
                          <SelectValue placeholder="No epic" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">No epic</SelectItem>
                          {(epics.data ?? []).map((e) => (
                            <SelectItem key={e.externalId} value={e.externalId}>
                              {e.title}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FieldShell>
                  </>
                )}
              </aside>
            </div>

            <DialogFooter>
              {eligible.length > 1 && (
                <Button type="button" variant="ghost" onClick={() => setStep("where")}>
                  ← Back
                </Button>
              )}
              <Button
                type="button"
                disabled={!canSubmit}
                loading={create.isPending}
                onClick={submit}
              >
                Create issue
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The sidebar controls that exist only because the provider says so (user request 2026-08-30).
 *
 * One component rather than five inline `&&`s in the form, so the gating rule is stated once and
 * in one place: **a control is drawn iff the manifest's `issueCreates` flag for it is true.** A
 * flag that is absent reads as false — a provider that has not answered offers nothing rather than
 * something its driver would refuse. On GitHub every flag is false and this renders nothing at
 * all, which is why there is no separator or heading outside the guard.
 */
function ProviderExtras({
  creates,
  dueDate,
  onDueDate,
  weight,
  onWeight,
  confidential,
  onConfidential,
  timeEstimate,
  onTimeEstimate,
  links,
  onLinks,
  repositoryId,
  enabled,
}: {
  creates: IssueCreateSupport | undefined;
  dueDate: string;
  onDueDate: (v: string) => void;
  weight: string;
  onWeight: (v: string) => void;
  confidential: boolean;
  onConfidential: (v: boolean) => void;
  timeEstimate: string;
  onTimeEstimate: (v: string) => void;
  links: IssueLinkDraft[];
  onLinks: (next: IssueLinkDraft[]) => void;
  repositoryId: string;
  enabled: boolean;
}) {
  if (!creates) return null;
  const any =
    creates.dueDate ||
    creates.weight ||
    creates.confidential ||
    creates.timeEstimate ||
    creates.links;
  if (!any) return null;

  return (
    <>
      <Separator />
      {creates.dueDate && (
        <FieldShell icon={<CalendarDays aria-hidden />} label="Due date">
          <Input
            type="date"
            aria-label="Due date"
            value={dueDate}
            onChange={(e) => onDueDate(e.target.value)}
          />
          {/* Said rather than left as a gap: the absence of a start date here is a fact about the
              provider, not an oversight (Decision 0018). */}
          <p className="text-2xs text-muted-foreground/70">
            An issue carries a due date only — start dates live on epics.
          </p>
        </FieldShell>
      )}

      {creates.timeEstimate && (
        <FieldShell icon={<Timer aria-hidden />} label="Estimate">
          <Input
            aria-label="Estimate"
            value={timeEstimate}
            onChange={(e) => onTimeEstimate(e.target.value)}
            placeholder="e.g. 2h, 3d, 1w 2d"
          />
        </FieldShell>
      )}

      {creates.weight && (
        <FieldShell icon={<Weight aria-hidden />} label="Weight">
          <Input
            type="number"
            min={0}
            aria-label="Weight"
            value={weight}
            onChange={(e) => onWeight(e.target.value)}
            placeholder="—"
          />
        </FieldShell>
      )}

      {creates.confidential && (
        <label htmlFor="create-issue-confidential" className="flex items-center gap-2 text-sm">
          <Checkbox
            id="create-issue-confidential"
            checked={confidential}
            onCheckedChange={(next) => onConfidential(next === true)}
          />
          <EyeOff aria-hidden className="size-3.5 text-muted-foreground" />
          Confidential
        </label>
      )}

      {creates.links && (
        <LinksField links={links} onLinks={onLinks} repositoryId={repositoryId} enabled={enabled} />
      )}
    </>
  );
}

/**
 * Linked items — "blocks / is blocked by / relates to" (user request 2026-08-30).
 *
 * The issue is picked from the repository's own Issues rather than typed as a number, for the
 * same reason the assignee picker is a picker: a number typed from memory is a link to whatever
 * happens to hold it. The relation is chosen per row, because "blocks" and "is blocked by" are
 * different facts about the same pair and picking one for the whole set would flatten them.
 *
 * These are applied *after* the issue exists — GitLab's create endpoint takes no links — which is
 * why the driver treats a refused link as leaving the created issue standing rather than failing
 * the create (see `GitlabProvider.createIssue`).
 */
function LinksField({
  links,
  onLinks,
  repositoryId,
  enabled,
}: {
  links: IssueLinkDraft[];
  onLinks: (next: IssueLinkDraft[]) => void;
  repositoryId: string;
  enabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<IssueLinkType>("relates_to");
  const issues = trpc.issue.list.useQuery(
    { repositoryId, ...WHOLE_PAGE },
    { enabled: enabled && repositoryId.length > 0 },
  );
  // Only issues that actually exist on the provider can be linked: a purely local Issue has no
  // `externalNumber` for the provider to resolve, so it is filtered out rather than offered and
  // refused — the same rule the repository picker applies to a repository with no integration.
  const candidates = (issues.data?.items ?? []).filter(
    (i): i is typeof i & { externalNumber: number } =>
      i.externalNumber !== null && !links.some((l) => l.issueNumber === i.externalNumber),
  );

  return (
    <FieldShell icon={<Link2 aria-hidden />} label="Linked items" count={links.length || undefined}>
      <Select value={type} onValueChange={(v) => setType(v as IssueLinkType)}>
        <SelectTrigger className="w-full" aria-label="Link type">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(LINK_TYPE_LABEL) as IssueLinkType[]).map((t) => (
            <SelectItem key={t} value={t}>
              {LINK_TYPE_LABEL[t]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            role="combobox"
            aria-expanded={open}
            aria-label="Linked items"
            className="w-full justify-between font-normal"
          >
            <span className="truncate text-muted-foreground">Link an issue</span>
            <ChevronsUpDown aria-hidden className="size-3.5 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-0" align="start">
          <Command>
            <CommandInput placeholder="Search issues" className="h-8" />
            <CommandList>
              <CommandEmpty>No issues found.</CommandEmpty>
              <CommandGroup>
                {candidates.map((i) => (
                  <CommandItem
                    key={i.id}
                    value={`#${i.externalNumber} ${i.title}`}
                    onSelect={() => {
                      onLinks([...links, { issueNumber: i.externalNumber, type, title: i.title }]);
                      setOpen(false);
                    }}
                  >
                    <span className="shrink-0 font-mono text-2xs text-muted-foreground">
                      #{i.externalNumber}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{i.title}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {links.length > 0 && (
        <ul className="space-y-1 pt-0.5">
          {links.map((l) => (
            <li key={`${l.type}:${l.issueNumber}`} className="flex items-center gap-1.5 text-xs">
              <span className="shrink-0 text-muted-foreground">{LINK_TYPE_LABEL[l.type]}</span>
              <span className="min-w-0 flex-1 truncate">
                #{l.issueNumber} {l.title}
              </span>
              <button
                type="button"
                aria-label={`Remove link to #${l.issueNumber}`}
                onClick={() => onLinks(links.filter((x) => x !== l))}
                className="shrink-0 opacity-60 hover:opacity-100"
              >
                <X aria-hidden className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </FieldShell>
  );
}

/**
 * The frame every sidebar control shares: a small icon + heading over its input. Keeping it one
 * component is what makes the four fields read as one column rather than four ad-hoc widgets.
 */
function FieldShell({
  icon,
  label,
  count,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  count?: number | undefined;
  children: React.ReactNode;
}) {
  return (
    <section className="grid gap-1.5">
      <div className="flex items-center gap-1.5 font-medium text-muted-foreground text-xs [&_svg]:size-3.5">
        {icon}
        <span>{label}</span>
        {count ? <span className="text-muted-foreground/60">· {count}</span> : null}
      </div>
      {children}
    </section>
  );
}

/** The two lines every picker shows before its options resolve — kept identical across all three. */
function PickerStatus({
  loading,
  error,
  empty,
  emptyText,
  onRetry,
}: {
  loading: boolean;
  error?: boolean;
  empty?: boolean;
  emptyText: string;
  onRetry?: () => void;
}) {
  if (loading) return <p className="text-muted-foreground text-xs">Loading…</p>;
  if (error)
    return (
      <div className="flex items-center justify-between gap-2">
        <p className="text-destructive text-xs">Couldn&apos;t load from the provider.</p>
        {onRetry && (
          <Button type="button" variant="ghost" size="sm" onClick={onRetry}>
            Retry
          </Button>
        )}
      </div>
    );
  if (empty) return <p className="text-muted-foreground text-xs">{emptyText}</p>;
  return null;
}

function AssigneeField({
  users,
  loading,
  error,
  selected,
  onToggle,
  onRetry,
}: {
  users: RepositoryAssigneeDto[];
  loading: boolean;
  error: boolean;
  selected: string[];
  onToggle: (login: string) => void;
  onRetry: () => void;
}) {
  const [open, setOpen] = useState(false);
  const chosen = users.filter((u) => selected.includes(u.login));
  return (
    <FieldShell
      icon={<UserPlus aria-hidden />}
      label="Assignees"
      count={selected.length || undefined}
    >
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            role="combobox"
            aria-expanded={open}
            aria-label="Assignees"
            className="w-full justify-between font-normal"
            disabled={loading || error}
          >
            <span className="truncate text-muted-foreground">
              {selected.length === 0 ? "Add assignees" : `${selected.length} selected`}
            </span>
            <ChevronsUpDown aria-hidden className="size-3.5 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-64 p-0" align="start">
          <Command>
            <CommandInput placeholder="Search people" className="h-8" />
            <CommandList>
              <CommandEmpty>No people found.</CommandEmpty>
              <CommandGroup>
                {users.map((u) => (
                  <CommandItem
                    key={u.login}
                    value={`${u.login} ${u.name ?? ""}`}
                    onSelect={() => onToggle(u.login)}
                  >
                    <Avatar className="size-5 shrink-0 border border-background">
                      {u.avatarUrl ? <AvatarImage src={u.avatarUrl} alt="" /> : null}
                      <AvatarFallback className="text-[9px] uppercase">
                        {u.login.slice(0, 2)}
                      </AvatarFallback>
                    </Avatar>
                    <span className="min-w-0 flex-1 truncate">{u.name ?? u.login}</span>
                    {selected.includes(u.login) && <Check className="ml-auto size-3.5" />}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <PickerStatus
        loading={loading}
        error={error}
        empty={!loading && !error && users.length === 0}
        emptyText="No assignable users on this repository."
        onRetry={onRetry}
      />
      {chosen.length > 0 && (
        <ul className="flex flex-wrap gap-1.5 pt-0.5">
          {chosen.map((u) => (
            <li key={u.login}>
              <button
                type="button"
                onClick={() => onToggle(u.login)}
                className="flex items-center gap-1 rounded-full border bg-muted/40 py-0.5 pr-1.5 pl-0.5 text-xs hover:bg-muted"
                aria-label={`Remove ${u.name ?? u.login}`}
              >
                <Avatar className="size-4 shrink-0">
                  {u.avatarUrl ? <AvatarImage src={u.avatarUrl} alt="" /> : null}
                  <AvatarFallback className="text-[8px] uppercase">
                    {u.login.slice(0, 2)}
                  </AvatarFallback>
                </Avatar>
                <span className="max-w-[7rem] truncate">{u.name ?? u.login}</span>
                <X aria-hidden className="size-3 opacity-60" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </FieldShell>
  );
}

function LabelField({
  labels,
  loading,
  error,
  selected,
  onToggle,
  onRetry,
}: {
  labels: RepositoryLabelDto[];
  loading: boolean;
  error: boolean;
  selected: string[];
  onToggle: (name: string) => void;
  onRetry: () => void;
}) {
  const [open, setOpen] = useState(false);
  const chosen = labels.filter((l) => selected.includes(l.name));
  // Split into per-category groups (Area · Priority · Size · Status · Type) when scoped labels are
  // present; anything without a recognised category shares one flat group (F23a — request 2026-08-30).
  const groups = useMemo(() => groupLabelsByCategory(labels), [labels]);
  return (
    <FieldShell icon={<Tags aria-hidden />} label="Labels" count={selected.length || undefined}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            role="combobox"
            aria-expanded={open}
            aria-label="Labels"
            className="w-full justify-between font-normal"
            disabled={loading || error}
          >
            <span className="truncate text-muted-foreground">
              {selected.length === 0 ? "Add labels" : `${selected.length} selected`}
            </span>
            <ChevronsUpDown aria-hidden className="size-3.5 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-64 p-0" align="start">
          <Command>
            <CommandInput placeholder="Search labels" className="h-8" />
            <CommandList>
              <CommandEmpty>No labels found.</CommandEmpty>
              {groups.map((group) => (
                <CommandGroup key={group.key} heading={group.heading ?? undefined}>
                  {group.items.map((l) => (
                    <CommandItem key={l.name} value={l.name} onSelect={() => onToggle(l.name)}>
                      <span
                        aria-hidden
                        className="size-2.5 shrink-0 rounded-full border"
                        style={{ backgroundColor: l.color ?? "transparent" }}
                      />
                      {/* Inside a category the prefix is redundant — the heading already says it —
                          so the short value shows; an ungrouped label keeps its full name. */}
                      <span className="min-w-0 flex-1 truncate">{l.short}</span>
                      {selected.includes(l.name) && <Check className="ml-auto size-3.5" />}
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <PickerStatus
        loading={loading}
        error={error}
        empty={!loading && !error && labels.length === 0}
        emptyText="No labels on this repository yet."
        onRetry={onRetry}
      />
      {chosen.length > 0 && (
        <ul className="flex flex-wrap gap-1.5 pt-0.5">
          {chosen.map((l) => (
            <li key={l.name}>
              <button
                type="button"
                onClick={() => onToggle(l.name)}
                className="flex items-center gap-1 rounded-full border bg-muted/40 px-2 py-0.5 text-xs hover:bg-muted"
                aria-label={`Remove ${l.name}`}
              >
                {l.color && (
                  <span
                    aria-hidden
                    className="size-2 shrink-0 rounded-full border"
                    style={{ backgroundColor: l.color }}
                  />
                )}
                <span className="max-w-[8rem] truncate">{l.name}</span>
                <X aria-hidden className="size-3 opacity-60" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </FieldShell>
  );
}

function MilestoneField({
  milestones,
  loading,
  value,
  onChange,
}: {
  milestones: RepositoryMilestoneDto[];
  loading: boolean;
  value: string;
  onChange: (externalId: string) => void;
}) {
  return (
    <FieldShell icon={<MilestoneIcon aria-hidden />} label="Milestone">
      <Select
        value={value || "none"}
        onValueChange={(v) => onChange(v === "none" ? "" : v)}
        disabled={loading || milestones.length === 0}
      >
        <SelectTrigger className="w-full" id="create-issue-milestone" aria-label="Milestone">
          <SelectValue placeholder="No milestone" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">No milestone</SelectItem>
          {milestones.map((m) => (
            <SelectItem key={m.externalId} value={m.externalId}>
              {m.title}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {!loading && milestones.length === 0 && (
        <p className="text-muted-foreground text-xs">No milestones on this repository.</p>
      )}
    </FieldShell>
  );
}
