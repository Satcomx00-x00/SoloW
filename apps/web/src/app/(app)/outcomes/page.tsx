import { OutcomesView } from "@/components/features/outcomes/outcomes-view";

export const metadata = { title: "Outcomes · SoloW" };

/**
 * Tasks shipped per week, how often a run reaches an approval and in how many attempts, and what
 * the turns cost (finding A4, spec F14), all read from what the loop already records.
 */
export default function OutcomesPage() {
  return <OutcomesView />;
}
