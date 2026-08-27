import { ProjectsHub } from "@/components/features/project/projects-hub";

export const metadata = { title: "Projects · SoloW" };

/**
 * The app's front door.
 *
 * A Project is the top level (F23): everything that is work is read inside one, so the list of
 * them is where a session starts. This route used to render a project's *table* and pick a
 * default project to show in it, which made "which project am I in" a question the URL could not
 * answer.
 */
export default function ProjectsPage() {
  return <ProjectsHub />;
}
