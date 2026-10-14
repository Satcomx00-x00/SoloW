import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { StatusScreen } from "@/components/features/shared/status-screen";
import { Button } from "@/components/ui/button";

/**
 * The 404 for every URL no route claims, in the app's own theme rather than Next's bare white page.
 *
 * Deliberately outside the signed-in shell. Keeping the sidebar would take a catch-all route in
 * `(app)` calling `notFound()`, and that catch-all would also swallow unknown `/api/*` paths and
 * the icons browsers probe for — running the session guard and database reads for each, and
 * answering a signed-out API client with a redirect to sign-in instead of a 404. One link back to
 * the Projects list is the cheaper way out.
 */
export default function NotFound() {
  return (
    <main className="flex min-h-[100dvh] flex-col">
      <StatusScreen
        code="404"
        title="This page doesn't exist"
        actions={
          <Button asChild size="sm">
            <Link href="/projects">
              <ArrowLeft /> Go to projects
            </Link>
          </Button>
        }
      >
        <p>The address may be mistyped, or it pointed at something that has since moved.</p>
      </StatusScreen>
    </main>
  );
}
