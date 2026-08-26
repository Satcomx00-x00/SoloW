import { Suspense } from "react";
import { IssuesView } from "@/components/features/issues/issues-view";

export const metadata = { title: "Unassigned · GateControl" };

/**
 * The issues that belong to no Project.
 *
 * Deliberately not a peer of the Project sections: it is an escape hatch, not a place to work.
 * It exists because an Issue imported before any Project existed — or one from a repository no
 * Project tracks — would otherwise have no screen at all, and would take the Tasks under it out
 * of reach with it. Adopt the project that holds them and they leave here on their own.
 */
export default function UnassignedPage() {
  return (
    <Suspense fallback={null}>
      <IssuesView unassigned />
    </Suspense>
  );
}
