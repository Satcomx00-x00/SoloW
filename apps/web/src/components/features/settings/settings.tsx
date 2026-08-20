"use client";

import { AgentProfilesSection } from "./agent-profiles-section";
import { ExecutorProfilesSection } from "./executor-profiles-section";
import { IntegrationsSection } from "./integrations-section";
import { McpSection } from "./mcp-section";
import { RepositoriesSection } from "./repositories-section";
import { SecretsSection } from "./secrets-section";
import { StatusBarSection } from "./status-bar-section";

/**
 * Settings (TASK-023): manage the resources a Task needs — Secrets (write-only), Agent Profiles
 * (auth mode + concurrency cap), Executor Profiles, and connected Repositories.
 *
 * A single readable column rather than a two-up grid. These are set up once, in order — a
 * credential, then the profile that uses it, then somewhere to run — and side-by-side cards
 * hide that sequence while making every form narrower than its own inputs want to be.
 */
export function Settings() {
  return (
    <div className="mx-auto w-full max-w-3xl space-y-8 px-6 py-6">
      <header className="space-y-1">
        <h1 className="font-semibold text-lg tracking-[-0.01em]">Settings</h1>
        <p className="text-sm text-muted-foreground leading-relaxed">
          What a task needs before it can run: a credential, an agent profile to spend it, a place
          to execute, and a repository to work in.
        </p>
      </header>
      <SecretsSection />
      <AgentProfilesSection />
      <ExecutorProfilesSection />
      <RepositoriesSection />
      <IntegrationsSection />
      <McpSection />
      <StatusBarSection />
    </div>
  );
}
