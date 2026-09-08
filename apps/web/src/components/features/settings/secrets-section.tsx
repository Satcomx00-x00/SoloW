"use client";

import type { SecretKind, SecretRefDto } from "@solow/contracts";
import { Trash2 } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ConfirmAction } from "@/components/features/confirm-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { trpc } from "@/trpc/react";
import {
  SectionStatus,
  SettingsCreate,
  SettingsEmpty,
  SettingsField,
  SettingsLoading,
  SettingsRow,
  SettingsRows,
  SettingsSection,
} from "./settings-shell";

/**
 * How a Secret's holders read in the list and in the confirmation. Named rather than counted:
 * "used by github, claude" tells the user what to detach; "used by 2 things" does not.
 */
function describeUsage(usedBy: SecretRefDto["usedBy"]): string {
  return usedBy.map((u) => u.name).join(", ");
}

/**
 * Set (write-only) Secrets and list their metadata — the value is never shown after entry.
 *
 * `?renewSecret=<name>` is the landing page for the "Renew" action a credential-expired Task
 * card offers (spec AC-013, issue #63): renewing a credential is just setting the same Secret
 * again, so this pre-fills the name (and, once the list has loaded, the matching kind) rather
 * than sending the Owner to a blank form they have to fill in from memory. The query param is
 * read once — after that the fields are the Owner's own edits to keep.
 */
export function SecretsSection() {
  const utils = trpc.useUtils();
  const secrets = trpc.secret.list.useQuery({});
  const renewTarget = useSearchParams().get("renewSecret");
  const [name, setName] = useState(renewTarget ?? "");
  const [kind, setKind] = useState<SecretKind>("api_key");
  const [value, setValue] = useState("");
  const [justResumed, setJustResumed] = useState<number | null>(null);

  const valueRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const prefilled = useRef(false);

  // Runs once the matching Secret's real kind is known, not on the raw query param alone — a
  // renewal must submit the same kind the existing row has, and guessing "api_key" by default
  // would silently change it. Scrolling and focusing the moment the target is known, rather than
  // waiting on the list, is what makes this feel like the one click the card promised instead of
  // two: a click into Settings, then hunting for the row by hand.
  useEffect(() => {
    if (!renewTarget || prefilled.current) return;
    cardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    valueRef.current?.focus();
    const existing = secrets.data?.find((s) => s.name === renewTarget);
    if (existing) {
      prefilled.current = true;
      // Deferred a tick rather than set synchronously here. Landing on this page by a client-
      // side <Link> transition (as the Renew action does) mounts `Select` and calls `setKind`
      // on the very same paint — before Radix's own mount effect has registered `SelectItem`'s
      // label with the trigger, so the value is set correctly but the visible text stays blank
      // and never self-corrects. A hard page load has enough of a gap between mount and this
      // effect for Radix to have already registered it, which is why the bug does not reproduce
      // there. `setTimeout(0)` — a macrotask — runs after that mount effect, every time.
      setTimeout(() => setKind(existing.kind), 0);
    }
  }, [renewTarget, secrets.data]);

  const setSecret = trpc.secret.set.useMutation({
    onSuccess: ({ resumedTaskCount }) => {
      utils.secret.list.invalidate();
      utils.task.invalidate();
      setName("");
      setValue("");
      setJustResumed(resumedTaskCount > 0 ? resumedTaskCount : null);
    },
  });

  const deleteSecret = trpc.secret.delete.useMutation({
    onSuccess: () => utils.secret.list.invalidate(),
  });

  const rows = secrets.data ?? [];
  // Open on the form only when there is nothing to look at, or when a Task sent the Owner here to
  // renew a specific credential. Otherwise the section is the list, and creating is a click.
  const openOnForm = renewTarget !== null || (secrets.isSuccess && rows.length === 0);

  return (
    <div ref={cardRef}>
      <SettingsSection
        caption="Write-only credentials. The value is never shown after entry."
        id="secrets"
        status={
          secrets.isSuccess ? (
            <SectionStatus>
              {rows.length === 0
                ? "None stored"
                : `${rows.length} stored · ${rows.filter((s) => s.usedBy.length > 0).length} in use`}
            </SectionStatus>
          ) : null
        }
        title="Secrets"
      >
        {secrets.isPending ? (
          <SettingsLoading rows={3} />
        ) : rows.length === 0 ? (
          <SettingsEmpty>
            No credentials stored yet. A harness needs one before it can run.
          </SettingsEmpty>
        ) : (
          <SettingsRows>
            {rows.map((s) => {
              const held = s.usedBy.length > 0;
              // A Secret in use is not deletable — the server refuses it, and a button that only
              // ever produces an error is worse than one that explains itself. The reason used to
              // sit only in the row above, which never said it *blocked* deletion and which a
              // keyboard user could not reach at all, because a disabled button takes no focus and
              // fires no pointer events. The title now rides on a wrapper, so the explanation is
              // available from the control itself.
              const reason = held
                ? `In use by ${describeUsage(s.usedBy)}. Detach it there before deleting.`
                : undefined;
              return (
                <SettingsRow
                  actions={
                    <span className="inline-flex" title={reason}>
                      <ConfirmAction
                        confirmLabel="Delete secret"
                        description="The stored value is encrypted and cannot be read back, so deleting it is permanent — you would have to obtain the credential again from wherever it came from."
                        disabled={held}
                        onConfirm={() => deleteSecret.mutate({ id: s.id })}
                        title={`Delete "${s.name}"?`}
                        trigger={
                          <Button
                            aria-label={`Delete the secret ${s.name}`}
                            disabled={held}
                            loading={deleteSecret.isPending && deleteSecret.variables?.id === s.id}
                            size="icon-sm"
                            type="button"
                            variant="ghost"
                          >
                            <Trash2 />
                          </Button>
                        }
                      />
                    </span>
                  }
                  key={s.id}
                  meta={held ? `Used by ${describeUsage(s.usedBy)}` : "Held by nothing"}
                  status={<Badge variant="secondary">{SECRET_KIND_LABELS[s.kind] ?? s.kind}</Badge>}
                  title={s.name}
                />
              );
            })}
          </SettingsRows>
        )}

        {deleteSecret.error && (
          <p className="text-destructive text-sm" role="alert">
            {deleteSecret.error.message}
          </p>
        )}

        <SettingsCreate defaultOpen={openOnForm} label="Add a secret">
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              setSecret.mutate({ name, kind, value });
            }}
          >
            <SettingsField htmlFor="secret-name" label="Name">
              <Input
                id="secret-name"
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. anthropic-api-key"
                required
                value={name}
              />
            </SettingsField>
            <SettingsField htmlFor="secret-kind" label="Kind">
              <Select onValueChange={(v) => setKind(v as SecretKind)} value={kind}>
                <SelectTrigger className="w-full" id="secret-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(SECRET_KIND_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsField>
            <SettingsField htmlFor="secret-value" label="Value">
              <Input
                id="secret-value"
                onChange={(e) => setValue(e.target.value)}
                placeholder="Paste the secret value"
                ref={valueRef}
                required
                type="password"
                value={value}
              />
            </SettingsField>
            <Button loading={setSecret.isPending} type="submit">
              Save secret
            </Button>
          </form>
          {setSecret.error && (
            <p className="text-destructive text-sm" role="alert">
              {setSecret.error.message}
            </p>
          )}
          {justResumed !== null && (
            <p className="text-feedback-ok text-sm" role="status">
              Saved. {justResumed} task{justResumed === 1 ? "" : "s"} paused on this credential{" "}
              {justResumed === 1 ? "has" : "have"} resumed.
            </p>
          )}
        </SettingsCreate>
      </SettingsSection>
    </div>
  );
}

/**
 * The kinds, in the Owner's words rather than the column's.
 *
 * `scm_pat` and `subscription_token` are database values and they were reaching the screen intact
 * — in the list badge, and in a select placeholder that read "Select a scm_pat secret". One map,
 * read by the form and the list, so the two can never drift into naming the same thing twice.
 */
export const SECRET_KIND_LABELS: Record<string, string> = {
  api_key: "API key",
  subscription_token: "Subscription token",
  scm_pat: "Access token",
};
