"use client";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { WHOLE_PAGE } from "@/lib/paged";
import { trpc } from "@/trpc/react";
import {
  SectionStatus,
  SettingsEmpty,
  SettingsField,
  SettingsLoading,
  SettingsSection,
} from "./settings-shell";

/**
 * What a new Task starts as (spec F16).
 *
 * Every Task needs a Harness Profile and an Executor Profile, and until now every Task form
 * opened with both empty — so cutting work from an Issue meant answering the same two questions
 * the same way every time, and getting them wrong meant a run on the wrong machine.
 *
 * A *default*, not a lock: the Task form still shows both pickers and both stay editable. The
 * only thing this changes is what they are already set to when the form opens.
 *
 * `NONE` rather than an empty string, because Radix's Select reserves `""` for "nothing
 * selected" and refuses it as an item value — the same sentinel `launch-issues-dialog.tsx` uses
 * for its optional Workflow.
 */

const NONE = "__none__";

export function TaskDefaultsSection() {
  const utils = trpc.useUtils();
  const harnesses = trpc.profile.agent.list.useQuery({ ...WHOLE_PAGE });
  const executors = trpc.profile.executor.list.useQuery({ ...WHOLE_PAGE });
  const defaults = trpc.preference.getTaskDefaults.useQuery({});
  const save = trpc.preference.setTaskDefaults.useMutation({
    onSuccess: () => utils.preference.getTaskDefaults.invalidate(),
  });

  const harnessItems = harnesses.data?.items ?? [];
  const executorItems = executors.data?.items ?? [];
  const current = defaults.data?.defaults;

  /*
   * Read straight from the query rather than mirrored into local state. The server already
   * answers null for a Profile that has since been deleted (`getTaskDefaults`), so the value
   * shown here is always one the pickers can actually render — holding a copy would mean
   * holding the stale id the server just went to the trouble of discarding.
   */
  const set = (field: "harnessProfileId" | "executorProfileId", value: string) => {
    if (!current) return;
    save.mutate({ ...current, [field]: value === NONE ? null : value });
  };

  const loading = harnesses.isPending || executors.isPending || defaults.isPending;
  const chosen = [current?.harnessProfileId, current?.executorProfileId].filter(Boolean).length;

  return (
    <SettingsSection
      caption="The harness and the executor a new Task opens with. Both stay editable on the Task form — this only decides what they start as, so the common case stops being a question you answer twice on every Task."
      id="task-defaults"
      status={
        loading ? null : (
          <SectionStatus tone={chosen === 2 ? "active" : "idle"}>
            {chosen === 0 ? "Nothing chosen" : `${chosen} of 2 set`}
          </SectionStatus>
        )
      }
      title="New task defaults"
    >
      {loading ? (
        <SettingsLoading rows={2} />
      ) : harnessItems.length === 0 && executorItems.length === 0 ? (
        // Nothing to default to yet. Saying so beats two pickers that can only be opened to
        // find them empty.
        <SettingsEmpty>
          Create a harness profile and an executor first — a default has to point at one.
        </SettingsEmpty>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <SettingsField
            hint="Which harness a new Task runs, and how it authenticates."
            label="Harness profile"
          >
            <Select
              onValueChange={(value) => set("harnessProfileId", value)}
              value={current?.harnessProfileId ?? NONE}
            >
              <SelectTrigger aria-label="Default harness profile">
                <SelectValue placeholder="Ask every time" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Ask every time</SelectItem>
                {harnessItems.map((profile) => (
                  <SelectItem key={profile.id} value={profile.id}>
                    {profile.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsField>

          <SettingsField hint="Where its commands actually run." label="Executor">
            <Select
              onValueChange={(value) => set("executorProfileId", value)}
              value={current?.executorProfileId ?? NONE}
            >
              <SelectTrigger aria-label="Default executor">
                <SelectValue placeholder="Ask every time" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Ask every time</SelectItem>
                {executorItems.map((profile) => (
                  <SelectItem key={profile.id} value={profile.id}>
                    {profile.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsField>
        </div>
      )}

      {save.error && (
        <p className="text-destructive text-sm" role="alert">
          {save.error.message}
        </p>
      )}

      {/* A deleted Profile silently clears its default, which is the right behaviour and an
          invisible one — so it is stated rather than left to be discovered on the next Task. */}
      {!loading && chosen < 2 && (
        <p className="text-muted-foreground text-xs">
          A default that names a profile you later delete is dropped, and the Task form asks again.
        </p>
      )}

      {/* Nothing to submit — each picker saves on change. The button exists only as the retry
          for a write that failed, so it appears only then. It re-sends the failed write's own
          input: `current` is still the stored pair, because the write did not land, and
          retrying that would report success while dropping the choice that failed. */}
      {save.error && save.variables && (
        <Button
          loading={save.isPending}
          onClick={() => save.variables && save.mutate(save.variables)}
          type="button"
        >
          Try again
        </Button>
      )}
    </SettingsSection>
  );
}
