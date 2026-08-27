import type { LabelSeed } from "./types.js";

/**
 * SoloW's default label taxonomy (user request 2026-08-27).
 *
 * For a repository that arrives with none of this — common on a fresh GitLab project, since
 * GitLab has no equivalent of GitHub's stock label set — an Owner can seed a starting vocabulary
 * instead of typing `type/feat`, `prio/p2` and the rest out by hand, issue by issue. Five
 * families, each a closed set of scoped values rather than a free-text convention:
 *
 *  - `type/*`  — what kind of change, the Conventional Commits vocabulary most tooling already
 *    reads in 2026 (`feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `perf`, `build`, `ci`,
 *    `style`, `revert`).
 *  - `prio/*`  — P0–P3, the scale most incident and triage tooling converged on (P0 "drop
 *    everything" through P3 "nice to have"), rather than a `high`/`medium`/`low` word scale two
 *    people rank differently.
 *  - `size/*`  — T-shirt sizing (`xs`…`xl`), for a rough-cut estimate that does not pretend to be
 *    a story-point count.
 *  - `status/*` — a minimal kanban vocabulary, for a repository whose Issue tracker has no board
 *    field of its own to carry it.
 *  - `area/*`  — a starting, genuinely generic split (`backend`, `frontend`, `infra`, `docs`,
 *    `tests`); the one family every real repository outgrows and is expected to add to.
 *
 * Additive only, like every "provision structure" write in this codebase
 * (`GitlabProjects.provisionProjectStructure`): a label already on the repository, under one of
 * these names or an unrelated one, is left exactly as it is. This seeds a starting vocabulary; it
 * does not enforce one.
 */
export const DEFAULT_LABEL_TAXONOMY: LabelSeed[] = [
  // type/* — green family for creation, red for correction, cooler tones for maintenance.
  { name: "type/feat", color: "#0e8a16", description: "A new feature" },
  { name: "type/fix", color: "#d73a4a", description: "A bug fix" },
  { name: "type/chore", color: "#6b7280", description: "Maintenance with no user-facing change" },
  { name: "type/docs", color: "#0075ca", description: "Documentation only" },
  { name: "type/refactor", color: "#a371f7", description: "Code change that alters no behavior" },
  { name: "type/test", color: "#bfd4f2", description: "Adding or correcting tests" },
  { name: "type/perf", color: "#fbca04", description: "A performance improvement" },
  { name: "type/build", color: "#5319e7", description: "Build system or dependencies" },
  { name: "type/ci", color: "#c2e0c6", description: "CI configuration and scripts" },
  { name: "type/style", color: "#e4e669", description: "Formatting, whitespace — no logic change" },
  { name: "type/revert", color: "#b60205", description: "Reverts a previous change" },

  // prio/* — a severity ramp from dark red (drop everything) to light green (nice to have).
  { name: "prio/p0", color: "#b60205", description: "Critical — drop everything" },
  { name: "prio/p1", color: "#d93f0b", description: "High — next up" },
  { name: "prio/p2", color: "#fbca04", description: "Medium — normal priority" },
  { name: "prio/p3", color: "#c2e0c6", description: "Low — nice to have" },

  // size/* — a light-to-dark blue ramp so the five read as one ordered scale.
  { name: "size/xs", color: "#bfd4f2", description: "Extra small — well under an hour" },
  { name: "size/s", color: "#9ec5eb", description: "Small — a few hours" },
  { name: "size/m", color: "#7cb0e0", description: "Medium — about a day" },
  { name: "size/l", color: "#5a86c9", description: "Large — several days" },
  { name: "size/xl", color: "#3a5fa8", description: "Extra large — consider splitting it up" },

  // status/* — for a tracker with no board field of its own.
  { name: "status/todo", color: "#d4c5f9", description: "Not started" },
  { name: "status/in-progress", color: "#fbca04", description: "Actively being worked" },
  { name: "status/in-review", color: "#1d76db", description: "Change is up for review" },
  { name: "status/blocked", color: "#e11d48", description: "Cannot proceed until something clears" },
  { name: "status/done", color: "#0e8a16", description: "Complete" },

  // area/* — a generic starting split, expected to grow with the repository.
  { name: "area/backend", color: "#5319e7", description: "Server-side code" },
  { name: "area/frontend", color: "#1d76db", description: "Client-side / UI code" },
  { name: "area/infra", color: "#6b7280", description: "Infrastructure, deployment, tooling" },
  { name: "area/docs", color: "#0075ca", description: "Documentation" },
  { name: "area/tests", color: "#bfd4f2", description: "Test suites and fixtures" },
];
