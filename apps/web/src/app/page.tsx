import { redirect } from "next/navigation";

/** A Project is the top level, so the front door is the list of them (F23). */
export default function Home() {
  redirect("/projects");
}
