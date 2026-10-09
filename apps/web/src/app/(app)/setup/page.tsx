import { GuidedSetup } from "@/components/features/workspace/guided-setup";

export const metadata = { title: "Setup · SoloW" };

/**
 * The guided setup, always on screen (spec F18 FR-6): the projects page shows it only until the
 * Workspace is ready, and this is where Settings sends someone who wants to change how Claude is
 * connected, add a repository, or run the test again.
 */
export default function SetupPage() {
  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-6">
      <GuidedSetup mode="rerun" />
    </div>
  );
}
