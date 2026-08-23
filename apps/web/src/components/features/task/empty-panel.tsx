/**
 * The placeholder a panel shows when it has nothing yet.
 *
 * Its own file because two panels now use it — the terminal and the task workspace's side
 * columns — and a shared component living inside one of them would make that one the other's
 * dependency for no reason.
 */
export function EmptyPanel({ label }: { label: string }) {
  return (
    <div className="flex h-full min-h-40 items-center justify-center p-8 text-center text-sm text-muted-foreground/60">
      {label}
    </div>
  );
}
