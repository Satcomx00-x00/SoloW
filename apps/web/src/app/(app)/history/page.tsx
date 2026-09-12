import { HistoryView } from "@/components/features/history/history-view";

export const metadata = { title: "History · SoloW" };

/**
 * The Tasks closed or deleted in the last seven days (spec F02 FR-10, F11; Decision 0025), and
 * the way back for each: restore a deleted one, reopen and resume a finished one.
 */
export default function HistoryPage() {
  return <HistoryView />;
}
