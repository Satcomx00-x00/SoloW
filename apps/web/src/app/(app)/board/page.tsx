import Link from "next/link";
import { Board } from "@/components/features/board/board";

export default function BoardPage() {
  return (
    <main>
      <header className="app-header">
        <h1>GateControl</h1>
        <span className="sub">Task board</span>
        <nav className="nav">
          <Link href="/settings">Settings</Link>
        </nav>
      </header>
      <Board />
    </main>
  );
}
