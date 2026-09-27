"use client";

import type { Theme } from "@solow/contracts";
import { Monitor, Moon, Sun } from "lucide-react";
import { resolveTheme, useTheme } from "@/components/theme";
import { cn } from "@/lib/utils";
import { SectionStatus, SettingsSection } from "./settings-shell";

/**
 * Light or dark (spec F16).
 *
 * Three radio cards rather than a Select or a Switch, and each reason is separate. A Switch has
 * two positions and there are three answers — `system` is a real one, not the absence of a
 * choice. A Select would hide the options behind a click, for a setting whose whole value is
 * being able to try one and watch the page change under you. And `flags-section.tsx` already
 * records why no Switch primitive exists in `components/ui` yet (issue #76 owns it), so
 * inventing one here would be building it twice.
 *
 * No Save button: the page repaints on press, and a confirmation step for something entirely
 * reversible and immediately visible is a step that only delays the answer. The write to the
 * server happens behind it, and the only thing that can fail is whether the choice *follows you
 * to another browser* — which is what the error line says, rather than pretending the theme did
 * not change.
 */

const OPTIONS: readonly { value: Theme; label: string; icon: typeof Sun; hint: string }[] = [
  { value: "light", label: "Light", icon: Sun, hint: "Always light" },
  { value: "dark", label: "Dark", icon: Moon, hint: "Always dark" },
  { value: "system", label: "System", icon: Monitor, hint: "Follow this machine" },
];

export function AppearanceSection() {
  const { theme, setTheme, saving, error } = useTheme();

  return (
    <SettingsSection
      caption="SoloW ships dark, because it is a console that sits open beside an editor all day. Choose otherwise here, or follow whatever this machine is set to. The choice is stored against your account, so it follows you to another browser."
      id="appearance"
      status={
        <SectionStatus tone={saving ? "waiting" : "idle"}>
          {saving
            ? "Saving…"
            : theme === "system"
              ? `System — ${resolveTheme("system")} right now`
              : theme === "dark"
                ? "Dark"
                : "Light"}
        </SectionStatus>
      }
      title="Appearance"
    >
      {/*
        Real `<input type="radio">` elements inside their labels, rather than buttons carrying
        `role="radio"`. Same appearance, and the browser supplies the whole of the behaviour a
        hand-rolled group has to re-implement and usually gets wrong: one tab stop for the set,
        arrow keys between the options, and the grouping announced from the fieldset's legend.
      */}
      <fieldset className="flex flex-wrap gap-2">
        <legend className="sr-only">Theme</legend>
        {OPTIONS.map((option) => {
          const active = theme === option.value;
          return (
            <label
              className={cn(
                "surface-edge flex min-w-36 flex-1 cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2.5 transition-colors",
                "focus-within:ring-2 focus-within:ring-ring",
                active ? "border-ring bg-accent" : "hover:bg-accent/50",
              )}
              key={option.value}
            >
              <input
                checked={active}
                className="sr-only"
                name="solow-theme"
                onChange={() => setTheme(option.value)}
                type="radio"
                value={option.value}
              />
              <option.icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0">
                <span className="block font-medium text-sm leading-tight">{option.label}</span>
                <span className="block text-muted-foreground text-xs leading-tight">
                  {option.hint}
                </span>
              </span>
            </label>
          );
        })}
      </fieldset>

      {error && (
        <p className="text-destructive text-sm" role="alert">
          {/* Deliberately not "could not change the theme" — it already changed. */}
          This browser is showing the theme you chose, but it could not be saved to your account:{" "}
          {error}
        </p>
      )}
    </SettingsSection>
  );
}
