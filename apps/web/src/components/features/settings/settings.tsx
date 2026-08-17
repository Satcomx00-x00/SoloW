"use client";

import { AgentProfilesSection } from "./agent-profiles-section";
import { ExecutorProfilesSection } from "./executor-profiles-section";
import { RepositoriesSection } from "./repositories-section";
import { SecretsSection } from "./secrets-section";

/**
 * Settings (TASK-023): manage the resources a Task needs — Secrets (write-only), Agent Profiles
 * (auth mode + concurrency cap), Executor Profiles, and connected Repositories.
 */
export function Settings() {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <SecretsSection />
      <AgentProfilesSection />
      <ExecutorProfilesSection />
      <RepositoriesSection />
    </div>
  );
}
