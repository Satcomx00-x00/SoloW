import type { McpServerTransport } from "@solow/contracts";

/**
 * The MCP store (spec F24): well-known servers, described once, installed into the library
 * with a click. Every entry is a *recipe* — the command or URL, which values it needs and which
 * of those are credentials — not a row: installing one asks for the Secrets it needs and writes
 * an ordinary MCP server the operator can edit or remove like any other.
 *
 * Curated by hand, not fetched: what this list says is loaded into a harness with the run's
 * credentials, so its contents are reviewed in a pull request rather than taken from a registry
 * at run time. Package names and endpoints are the ones each vendor publishes; a `homepage` on
 * every entry is where to check them.
 */

export type McpStoreCategory =
  | "source-control"
  | "local"
  | "browser"
  | "docs"
  | "search"
  | "data"
  | "cloud"
  | "productivity"
  | "gateway";

/** A value an entry needs from the operator: a credential (kept as a Secret) or a plain setting. */
export type McpStoreInput = {
  /** The env variable (stdio) or header (http) it fills. */
  name: string;
  label: string;
  /** A credential: chosen from the Secrets, never typed here. */
  secret: boolean;
  required: boolean;
  /** Written in front of a Secret's value at run time — `Bearer ` for an Authorization header. */
  prefix?: string;
  /** For a plain setting: what to write when the operator leaves it empty; omitted when unset. */
  defaultValue?: string;
  hint?: string;
};

export type McpStoreEntry = {
  id: string;
  /** The library name the install writes, and what the harness sees the server as. */
  name: string;
  title: string;
  description: string;
  category: McpStoreCategory;
  homepage: string;
  vendor: string;
  /** No credential, no account: works on a fresh install. */
  local: boolean;
  transport:
    | { kind: "stdio"; command: string; args: string[]; inputs: McpStoreInput[] }
    | { kind: "http"; url: string; inputs: McpStoreInput[] };
};

const npx = (pkg: string, ...args: string[]) => ({ command: "npx", args: ["-y", pkg, ...args] });
const uvx = (pkg: string, ...args: string[]) => ({ command: "uvx", args: [pkg, ...args] });
const token = (name: string, label: string, hint?: string): McpStoreInput => ({
  name,
  label,
  secret: true,
  required: true,
  ...(hint ? { hint } : {}),
});
const bearer = (label: string, required: boolean, hint?: string): McpStoreInput => ({
  name: "Authorization",
  label,
  secret: true,
  required,
  prefix: "Bearer ",
  ...(hint ? { hint } : {}),
});
const setting = (
  name: string,
  label: string,
  defaultValue?: string,
  hint?: string,
): McpStoreInput => ({
  name,
  label,
  secret: false,
  required: false,
  ...(defaultValue !== undefined ? { defaultValue } : {}),
  ...(hint ? { hint } : {}),
});

export const MCP_STORE: readonly McpStoreEntry[] = [
  // ---- Source control ----
  {
    id: "github",
    name: "github",
    title: "GitHub",
    description: "Issues, pull requests, files, searches and repository administration on GitHub.",
    category: "source-control",
    vendor: "GitHub (remote server)",
    homepage: "https://github.com/github/github-mcp-server",
    local: false,
    transport: {
      kind: "http",
      url: "https://api.githubcopilot.com/mcp/",
      inputs: [
        bearer(
          "GitHub personal access token",
          true,
          "A fine-grained or classic PAT with the scopes the harness needs.",
        ),
      ],
    },
  },
  {
    id: "github-local",
    name: "github-local",
    title: "GitHub (local server)",
    description:
      "The same GitHub tools run as a local process — for a machine that cannot reach the remote server.",
    category: "source-control",
    vendor: "Model Context Protocol",
    homepage: "https://github.com/modelcontextprotocol/servers-archived/tree/main/src/github",
    local: false,
    transport: {
      kind: "stdio",
      ...npx("@modelcontextprotocol/server-github"),
      inputs: [token("GITHUB_PERSONAL_ACCESS_TOKEN", "GitHub personal access token")],
    },
  },
  {
    id: "gitlab",
    name: "gitlab",
    title: "GitLab",
    description:
      "Projects, issues, merge requests, pipelines and files on gitlab.com or a self-hosted GitLab.",
    category: "source-control",
    vendor: "zereight",
    homepage: "https://github.com/zereight/gitlab-mcp",
    local: false,
    transport: {
      kind: "stdio",
      ...npx("@zereight/mcp-gitlab"),
      inputs: [
        token("GITLAB_PERSONAL_ACCESS_TOKEN", "GitLab personal access token"),
        setting(
          "GITLAB_API_URL",
          "API URL",
          "https://gitlab.com/api/v4",
          "Your instance's /api/v4 for self-hosted GitLab.",
        ),
      ],
    },
  },
  {
    id: "git",
    name: "git",
    title: "Git",
    description:
      "Read and search the history, diffs and branches of the repositories the harness works in.",
    category: "source-control",
    vendor: "Model Context Protocol",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/git",
    local: true,
    transport: { kind: "stdio", ...uvx("mcp-server-git"), inputs: [] },
  },

  // ---- Local, no account ----
  {
    id: "memory",
    name: "memory",
    title: "Memory",
    description:
      "A knowledge-graph memory the harness reads and writes across runs, kept in a local file.",
    category: "local",
    vendor: "Model Context Protocol",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
    local: true,
    transport: { kind: "stdio", ...npx("@modelcontextprotocol/server-memory"), inputs: [] },
  },
  {
    id: "filesystem",
    name: "filesystem",
    title: "Filesystem",
    description: "Read, write and search files under the directory the harness runs in.",
    category: "local",
    vendor: "Model Context Protocol",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
    local: true,
    transport: {
      kind: "stdio",
      ...npx("@modelcontextprotocol/server-filesystem", "."),
      inputs: [],
    },
  },
  {
    id: "sequential-thinking",
    name: "sequential-thinking",
    title: "Sequential thinking",
    description: "A scratchpad tool for working through a problem in revisable, numbered steps.",
    category: "local",
    vendor: "Model Context Protocol",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking",
    local: true,
    transport: {
      kind: "stdio",
      ...npx("@modelcontextprotocol/server-sequential-thinking"),
      inputs: [],
    },
  },
  {
    id: "time",
    name: "time",
    title: "Time",
    description: "The current time and conversions between time zones.",
    category: "local",
    vendor: "Model Context Protocol",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/time",
    local: true,
    transport: { kind: "stdio", ...uvx("mcp-server-time"), inputs: [] },
  },
  {
    id: "fetch",
    name: "fetch",
    title: "Fetch",
    description: "Fetch a web page and hand it to the harness as markdown.",
    category: "local",
    vendor: "Model Context Protocol",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
    local: true,
    transport: { kind: "stdio", ...uvx("mcp-server-fetch"), inputs: [] },
  },
  {
    id: "sqlite",
    name: "sqlite",
    title: "SQLite",
    description: "Query and change a SQLite database file.",
    category: "data",
    vendor: "Model Context Protocol",
    homepage: "https://github.com/modelcontextprotocol/servers-archived/tree/main/src/sqlite",
    local: true,
    transport: {
      kind: "stdio",
      ...uvx("mcp-server-sqlite", "--db-path", "./data.db"),
      inputs: [],
    },
  },

  // ---- Browser ----
  {
    id: "playwright",
    name: "playwright",
    title: "Playwright",
    description:
      "Drive a real browser: navigate, click, fill forms, read the page and take screenshots.",
    category: "browser",
    vendor: "Microsoft",
    homepage: "https://github.com/microsoft/playwright-mcp",
    local: true,
    transport: { kind: "stdio", command: "npx", args: ["@playwright/mcp@latest"], inputs: [] },
  },
  {
    id: "chrome-devtools",
    name: "chrome-devtools",
    title: "Chrome DevTools",
    description:
      "Inspect and automate a Chrome instance: DOM, console, network, performance traces.",
    category: "browser",
    vendor: "Google",
    homepage: "https://github.com/ChromeDevTools/chrome-devtools-mcp",
    local: true,
    transport: { kind: "stdio", ...npx("chrome-devtools-mcp@latest"), inputs: [] },
  },

  // ---- Documentation ----
  {
    id: "context7",
    name: "context7",
    title: "Context7",
    description: "Up-to-date documentation and code examples for libraries, by name and version.",
    category: "docs",
    vendor: "Upstash",
    homepage: "https://github.com/upstash/context7",
    local: true,
    transport: {
      kind: "http",
      url: "https://mcp.context7.com/mcp",
      inputs: [bearer("Context7 API key", false, "Optional: raises the rate limit.")],
    },
  },
  {
    id: "deepwiki",
    name: "deepwiki",
    title: "DeepWiki",
    description:
      "Ask questions about any public GitHub repository, answered from its generated wiki.",
    category: "docs",
    vendor: "Cognition",
    homepage: "https://docs.devin.ai/work-with-devin/deepwiki-mcp",
    local: true,
    transport: { kind: "http", url: "https://mcp.deepwiki.com/mcp", inputs: [] },
  },
  {
    id: "cloudflare-docs",
    name: "cloudflare-docs",
    title: "Cloudflare docs",
    description: "Search Cloudflare's developer documentation.",
    category: "docs",
    vendor: "Cloudflare",
    homepage: "https://github.com/cloudflare/mcp-server-cloudflare",
    local: true,
    transport: { kind: "http", url: "https://docs.mcp.cloudflare.com/mcp", inputs: [] },
  },

  // ---- Search ----
  {
    id: "brave-search",
    name: "brave-search",
    title: "Brave Search",
    description: "Web, news, image and local search through the Brave Search API.",
    category: "search",
    vendor: "Brave",
    homepage: "https://github.com/brave/brave-search-mcp-server",
    local: false,
    transport: {
      kind: "stdio",
      ...npx("@brave/brave-search-mcp-server"),
      inputs: [token("BRAVE_API_KEY", "Brave Search API key")],
    },
  },
  {
    id: "tavily",
    name: "tavily",
    title: "Tavily",
    description: "Search and extract web content built for agents.",
    category: "search",
    vendor: "Tavily",
    homepage: "https://github.com/tavily-ai/tavily-mcp",
    local: false,
    transport: {
      kind: "stdio",
      ...npx("tavily-mcp@latest"),
      inputs: [token("TAVILY_API_KEY", "Tavily API key")],
    },
  },
  {
    id: "exa",
    name: "exa",
    title: "Exa",
    description: "Neural web search, with the page contents.",
    category: "search",
    vendor: "Exa",
    homepage: "https://github.com/exa-labs/exa-mcp-server",
    local: false,
    transport: {
      kind: "stdio",
      ...npx("exa-mcp-server"),
      inputs: [token("EXA_API_KEY", "Exa API key")],
    },
  },
  {
    id: "firecrawl",
    name: "firecrawl",
    title: "Firecrawl",
    description: "Scrape, crawl and extract structured data from websites.",
    category: "search",
    vendor: "Firecrawl",
    homepage: "https://github.com/mendableai/firecrawl-mcp-server",
    local: false,
    transport: {
      kind: "stdio",
      ...npx("firecrawl-mcp"),
      inputs: [token("FIRECRAWL_API_KEY", "Firecrawl API key")],
    },
  },

  // ---- Data ----
  {
    id: "postgres",
    name: "postgres",
    title: "PostgreSQL",
    description:
      "Query a PostgreSQL database, inspect its schema and check the health of its indexes.",
    category: "data",
    vendor: "Crystal DBA",
    homepage: "https://github.com/crystaldba/postgres-mcp",
    local: false,
    transport: {
      kind: "stdio",
      ...uvx("postgres-mcp", "--access-mode=restricted"),
      inputs: [
        token(
          "DATABASE_URI",
          "Connection URI",
          "postgresql://user:password@host:5432/db — kept as a Secret.",
        ),
      ],
    },
  },
  {
    id: "supabase",
    name: "supabase",
    title: "Supabase",
    description: "Tables, SQL, migrations, edge functions and logs of a Supabase project.",
    category: "data",
    vendor: "Supabase",
    homepage: "https://github.com/supabase-community/supabase-mcp",
    local: false,
    transport: {
      kind: "stdio",
      ...npx("@supabase/mcp-server-supabase@latest", "--read-only"),
      inputs: [token("SUPABASE_ACCESS_TOKEN", "Supabase personal access token")],
    },
  },

  // ---- Cloud & infrastructure ----
  {
    id: "aws",
    name: "aws",
    title: "AWS",
    description: "AWS documentation, guidance and the entry point to the AWS MCP servers.",
    category: "cloud",
    vendor: "AWS Labs",
    homepage: "https://github.com/awslabs/mcp",
    local: false,
    transport: {
      kind: "stdio",
      ...uvx("awslabs.core-mcp-server@latest"),
      inputs: [
        setting("AWS_PROFILE", "AWS profile", "default"),
        setting("AWS_REGION", "Region", "us-east-1"),
      ],
    },
  },
  {
    id: "kubernetes",
    name: "kubernetes",
    title: "Kubernetes",
    description: "Pods, deployments, services and logs of the cluster your kubeconfig points at.",
    category: "cloud",
    vendor: "Flux159",
    homepage: "https://github.com/Flux159/mcp-server-kubernetes",
    local: true,
    transport: { kind: "stdio", ...npx("mcp-server-kubernetes"), inputs: [] },
  },
  {
    id: "docker",
    name: "docker",
    title: "Docker",
    description: "Containers, images, volumes and networks on the local Docker daemon.",
    category: "cloud",
    vendor: "ckreiling",
    homepage: "https://github.com/ckreiling/mcp-server-docker",
    local: true,
    transport: { kind: "stdio", ...uvx("mcp-server-docker"), inputs: [] },
  },
  {
    id: "sentry",
    name: "sentry",
    title: "Sentry",
    description: "Issues, errors and traces from your Sentry organisation.",
    category: "cloud",
    vendor: "Sentry",
    homepage: "https://github.com/getsentry/sentry-mcp",
    local: false,
    transport: {
      kind: "http",
      url: "https://mcp.sentry.dev/mcp",
      inputs: [
        bearer(
          "Sentry access token",
          false,
          "Optional: without it the harness signs in with OAuth.",
        ),
      ],
    },
  },

  // ---- Productivity ----
  {
    id: "slack",
    name: "slack",
    title: "Slack",
    description: "Read channels and threads, post messages and reactions as a Slack bot.",
    category: "productivity",
    vendor: "Model Context Protocol",
    homepage: "https://github.com/modelcontextprotocol/servers-archived/tree/main/src/slack",
    local: false,
    transport: {
      kind: "stdio",
      ...npx("@modelcontextprotocol/server-slack"),
      inputs: [
        token("SLACK_BOT_TOKEN", "Slack bot token"),
        setting("SLACK_TEAM_ID", "Team ID", undefined, "The workspace's T… id."),
      ],
    },
  },
  {
    id: "notion",
    name: "notion",
    title: "Notion",
    description: "Search, read and write pages and databases in a Notion workspace.",
    category: "productivity",
    vendor: "Notion",
    homepage: "https://github.com/makenotion/notion-mcp-server",
    local: false,
    transport: {
      kind: "stdio",
      ...npx("@notionhq/notion-mcp-server"),
      inputs: [token("NOTION_TOKEN", "Notion integration token")],
    },
  },
  {
    id: "linear",
    name: "linear",
    title: "Linear",
    description: "Issues, projects and cycles in Linear.",
    category: "productivity",
    vendor: "Linear",
    homepage: "https://linear.app/docs/mcp",
    local: false,
    transport: {
      kind: "http",
      url: "https://mcp.linear.app/mcp",
      inputs: [
        bearer("Linear API key", false, "Optional: without it the harness signs in with OAuth."),
      ],
    },
  },
  {
    id: "atlassian",
    name: "atlassian",
    title: "Atlassian (Jira & Confluence)",
    description: "Jira issues and Confluence pages, through Atlassian's hosted server.",
    category: "productivity",
    vendor: "Atlassian",
    homepage: "https://support.atlassian.com/atlassian-rovo-mcp-server/",
    local: false,
    transport: { kind: "http", url: "https://mcp.atlassian.com/v1/mcp", inputs: [] },
  },
  {
    id: "figma",
    name: "figma",
    title: "Figma",
    description: "Read design files, components and variables from Figma.",
    category: "productivity",
    vendor: "Figma",
    homepage: "https://help.figma.com/hc/en-us/articles/32132100833559",
    local: false,
    transport: { kind: "http", url: "https://mcp.figma.com/mcp", inputs: [] },
  },
  {
    id: "stripe",
    name: "stripe",
    title: "Stripe",
    description: "Customers, products, prices, invoices and payments in a Stripe account.",
    category: "productivity",
    vendor: "Stripe",
    homepage: "https://github.com/stripe/agent-toolkit",
    local: false,
    transport: {
      kind: "stdio",
      ...npx("@stripe/mcp", "--tools=all"),
      inputs: [
        token(
          "STRIPE_SECRET_KEY",
          "Stripe secret key",
          "A restricted key with only the permissions the harness needs.",
        ),
      ],
    },
  },

  // ---- Gateways ----
  {
    id: "agentgateway",
    name: "agentgateway",
    title: "agentgateway",
    description:
      "Every server behind an agentgateway, through its one /mcp endpoint — point it at yours.",
    category: "gateway",
    vendor: "agentgateway",
    homepage: "https://agentgateway.dev",
    local: true,
    transport: {
      kind: "http",
      url: "http://localhost:3000/mcp",
      inputs: [bearer("Gateway token", false, "Only if the gateway's policy asks for one.")],
    },
  },
];

export const MCP_STORE_CATEGORIES: readonly { id: McpStoreCategory; label: string }[] = [
  { id: "source-control", label: "Source control" },
  { id: "local", label: "Local tools" },
  { id: "browser", label: "Browser" },
  { id: "docs", label: "Documentation" },
  { id: "search", label: "Search & scraping" },
  { id: "data", label: "Data" },
  { id: "cloud", label: "Cloud & infra" },
  { id: "productivity", label: "Productivity" },
  { id: "gateway", label: "Gateways" },
];

export function mcpStoreEntry(id: string): McpStoreEntry | undefined {
  return MCP_STORE.find((entry) => entry.id === id);
}

/**
 * The transport an install writes, from the entry and what the operator filled in: a Secret id
 * per credential, a string per setting. A required credential left out is refused by name so the
 * form can point at it; an optional one left out is simply not written — the server is started
 * without that variable or header. A setting left empty falls back to the entry's default, or
 * is left out when there is none.
 */
export function mcpStoreTransport(
  entry: McpStoreEntry,
  filled: { secrets: Record<string, string>; settings: Record<string, string> },
): { ok: true; transport: McpServerTransport } | { ok: false; missing: string[] } {
  const values: Record<
    string,
    { kind: "literal"; value: string } | { kind: "secret"; secretId: string; prefix?: string }
  > = {};
  const missing: string[] = [];
  for (const input of entry.transport.inputs) {
    if (input.secret) {
      const secretId = filled.secrets[input.name];
      if (!secretId) {
        if (input.required) missing.push(input.name);
        continue;
      }
      values[input.name] = {
        kind: "secret",
        secretId,
        ...(input.prefix ? { prefix: input.prefix } : {}),
      };
    } else {
      const value = (filled.settings[input.name] ?? "").trim() || input.defaultValue;
      if (value !== undefined && value !== "") values[input.name] = { kind: "literal", value };
    }
  }
  if (missing.length > 0) return { ok: false, missing };
  if (entry.transport.kind === "stdio") {
    return {
      ok: true,
      transport: {
        kind: "stdio",
        command: entry.transport.command,
        args: [...entry.transport.args],
        env: values,
      },
    };
  }
  return { ok: true, transport: { kind: "http", url: entry.transport.url, headers: values } };
}
