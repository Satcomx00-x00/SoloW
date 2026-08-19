import { GithubProvider } from "./github.js";
import { GitlabProvider } from "./gitlab.js";
import type { ChangeProvider, ScmProvider } from "./types.js";

export { GithubProvider } from "./github.js";
export { GitlabProvider } from "./gitlab.js";
export * from "./types.js";

/** Resolve the driver for a stored `integration.provider` value. */
export function providerFor(provider: ScmProvider): ChangeProvider {
  switch (provider) {
    case "github":
      return new GithubProvider();
    case "gitlab":
      return new GitlabProvider();
  }
}
