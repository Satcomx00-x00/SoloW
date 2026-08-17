import Link from "next/link";
import { Settings } from "@/components/features/settings/settings";

export default function SettingsPage() {
  return (
    <main>
      <header className="app-header">
        <h1>GateControl</h1>
        <span className="sub">Settings</span>
        <nav className="nav">
          <Link href="/board">Board</Link>
        </nav>
      </header>
      <Settings />
    </main>
  );
}
