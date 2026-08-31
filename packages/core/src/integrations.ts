import {
  err,
  INTEGRATION_CAPABILITIES,
  type IntegrationCapability,
  type IssueCreateSupport,
  type IssueWriteSupport,
  ok,
  type ProjectFieldSupport,
  type ProviderField,
  type ProviderId,
  type ProviderManifestDto,
  providerIdSchema,
  type Result,
} from "@solow/contracts";

/**
 * The integration provider registry (F21, Decision 0016).
 *
 * `registry.ts` next door does this for the command palette, the status bar and notification
 * channels; this is the same idea for the things SoloW connects to. It is a separate type
 * rather than a `Registry<ProviderDescriptor>` because the two differ in the one place that
 * matters: a contribution is ordered and arranged by the user, and a provider is not — it is
 * *resolved*, by id or by what it can do, and a user never sorts the list. Sharing the type
 * would mean carrying `priority`, `when` and a saved layout into a surface that has no use for
 * any of them.
 *
 * What it exists to remove: a third provider used to mean editing eight files that enumerated
 * the two we had. Now a provider is registered, and the eight ask the registry.
 *
 * Nothing here imports infrastructure. `Driver` is whatever the caller's boundary needs — in
 * practice `@solow/scm`'s driver interface — so the ordering, the capability rules and the
 * duplicate-id refusal are testable without a network call, and the registry itself does not
 * know that a provider talks HTTP.
 */

export interface ProviderDescriptor<Driver> {
  readonly id: ProviderId;
  /** How the provider is spelled where a person reads it. */
  readonly name: string;
  /**
   * What this provider can answer questions about. The registry checks these against the driver
   * at registration time — see `ProviderRegistryErrorCode.CapabilityNotImplemented`.
   */
  readonly capabilities: readonly IntegrationCapability[];
  readonly fields: readonly ProviderField[];
  /** The provider's own word for a change request, for display beside a link to its own UI. */
  readonly changeRequestNoun?: string;
  /**
   * Which project field types this provider can express, and why not for the rest.
   *
   * Required in practice for a provider declaring `projects`, and meaningless without it — the
   * capability says "I have a project"; this says what that project can hold (Decision 0018).
   */
  readonly projectFields?: ProjectFieldSupport;
  /**
   * Which parts of an issue this provider can be asked to change, and why not for the rest.
   *
   * Stands to `issueWrites` as `projectFields` stands to `projects`: the capability says an edit
   * can be sent, this says what an edit may contain. An editor reads it to decide which controls
   * to render at all — never the provider's name.
   */
  readonly issueWrites?: IssueWriteSupport;
  /**
   * Whether this provider can create an Epic, for a provider declaring `issueCreates` (spec
   * F23a). Stands to `issueCreates` as `issueWrites` stands to `issueWrites` above: the
   * capability says a new Issue can be posted, this says whether a new Epic can be too — GitHub
   * cannot, GitLab can, and a caller asks this rather than the provider's name (Decision 0016).
   */
  readonly issueCreates?: IssueCreateSupport;
  readonly driver: Driver;
}

export const ProviderRegistryErrorCode = {
  DuplicateId: "PROVIDER_DUPLICATE_ID",
  InvalidId: "PROVIDER_INVALID_ID",
  /** A manifest naming a capability whose methods the driver does not have. */
  CapabilityNotImplemented: "PROVIDER_CAPABILITY_NOT_IMPLEMENTED",
  /** `local` is the absence of a provider; no driver may claim it. */
  ReservedId: "PROVIDER_RESERVED_ID",
} as const;
export type ProviderRegistryErrorCode =
  (typeof ProviderRegistryErrorCode)[keyof typeof ProviderRegistryErrorCode];

/** Ids a driver may not register, because the domain already means something by them. */
const RESERVED_IDS: ReadonlySet<string> = new Set(["local"]);

/**
 * The methods a driver must have to honour each capability it claims.
 *
 * Checked at registration rather than at the call, which is the whole point of declaring a
 * capability: a manifest that promises `issues` and supplies no `listIssues` is a programming
 * error in a driver, and the honest moment to find it is at start-up, before anything has been
 * connected through it (F21, edge cases). Discovering it when an Owner presses Import would make
 * a driver bug look like a provider outage.
 */
const REQUIRED_METHODS: Record<IntegrationCapability, readonly string[]> = {
  issues: ["listIssues", "getIssue", "listLabels", "listComments"],
  issueWrites: ["updateIssue", "listAssignableUsers", "listMilestones", "createComment"],
  repositories: ["listRepositories", "getRepository", "listBranches"],
  changeRequests: ["listChangeRequests"],
  projects: ["listProjects", "readProjectFields", "readProjectItems", "writeProjectFieldValue"],
  labelWrites: ["createLabels"],
  issueCreates: ["createIssue", "createEpic", "listGroups", "listEpics", "listIssueTypes"],
};

export class ProviderRegistry<Driver extends object> {
  private readonly providers = new Map<string, ProviderDescriptor<Driver>>();

  /**
   * Registration is the only way in — the property F19 named as the precondition for a plugin
   * API, and the only thing a future sandbox would have to police.
   *
   * A duplicate id keeps the registration already in place (F21 FR-5). Preferring the newcomer
   * would make behaviour depend on module load order, which is exactly what a registry is for
   * removing.
   */
  register(descriptor: ProviderDescriptor<Driver>): Result<void, ProviderRegistryErrorCode> {
    if (!providerIdSchema.safeParse(descriptor.id).success) {
      return err(ProviderRegistryErrorCode.InvalidId);
    }
    if (RESERVED_IDS.has(descriptor.id)) return err(ProviderRegistryErrorCode.ReservedId);
    if (this.providers.has(descriptor.id)) return err(ProviderRegistryErrorCode.DuplicateId);

    for (const capability of descriptor.capabilities) {
      for (const method of REQUIRED_METHODS[capability]) {
        if (typeof (descriptor.driver as Record<string, unknown>)[method] !== "function") {
          return err(ProviderRegistryErrorCode.CapabilityNotImplemented);
        }
      }
    }

    this.providers.set(descriptor.id, descriptor);
    return ok(undefined);
  }

  /** Undo a registration. An id becomes available again, which is what makes tests independent. */
  unregister(id: string): void {
    this.providers.delete(id);
  }

  /** The descriptor for a stored id, or null when nothing registers it — an orphan (F21 FR-7). */
  get(id: string): ProviderDescriptor<Driver> | null {
    return this.providers.get(id) ?? null;
  }

  /** Whether this build can actually act through a stored provider id. */
  has(id: string): boolean {
    return this.providers.has(id);
  }

  /**
   * Every registered provider, or only those declaring `capability`.
   *
   * Sorted by id rather than by registration order, so the settings picker lists the same
   * providers in the same sequence whatever order the modules happened to load in (F21 NFR-2).
   */
  list(capability?: IntegrationCapability): ProviderDescriptor<Driver>[] {
    const all = [...this.providers.values()];
    const matching = capability ? all.filter((p) => p.capabilities.includes(capability)) : all;
    return matching.sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * The provider registered under `id`, but only if it declares `capability`.
   *
   * Null covers both "no such provider" and "that provider does not do this", because neither
   * gives a caller anything to call — and both are ordinary states, not faults.
   *
   * It deliberately does *not* try to narrow the driver's type. What "having the issues
   * capability" means in types is `IssuesCapability`, and that interface names `ExternalIssue`,
   * which is the driver boundary's vocabulary — `@solow/core` has no business knowing it.
   * So the boundary does the narrowing (see `providerWith` in `@solow/scm`), and what this
   * guarantees is the fact the narrowing rests on: registration refused any manifest whose driver
   * was missing the methods, so a descriptor returned here provably has them.
   */
  with(id: string, capability: IntegrationCapability): ProviderDescriptor<Driver> | null {
    const found = this.providers.get(id);
    if (!found?.capabilities.includes(capability)) return null;
    return found;
  }
}

/** Every capability name, for a caller iterating them (a settings page, a test). */
export { INTEGRATION_CAPABILITIES };

/** The manifest half of a descriptor, as the client receives it. Drops the driver, and only it. */
export function toManifest<Driver>(descriptor: ProviderDescriptor<Driver>): ProviderManifestDto {
  return {
    id: descriptor.id,
    name: descriptor.name,
    capabilities: [...descriptor.capabilities],
    fields: [...descriptor.fields],
    ...(descriptor.changeRequestNoun ? { changeRequestNoun: descriptor.changeRequestNoun } : {}),
    // Published to the client, because "can this project hold a number" is a question the table
    // asks on every render and must not answer from a provider's name (Decision 0018).
    ...(descriptor.projectFields ? { projectFields: descriptor.projectFields } : {}),
    // Same reason: which controls an issue editor may draw is a question about the provider's
    // abilities, asked on every render, and answering it from an id is what Decision 0016 forbids.
    ...(descriptor.issueWrites ? { issueWrites: descriptor.issueWrites } : {}),
    // Same reason again: whether the "New epic" menu entry is offered or shown disabled with a
    // reason is a question about this provider's abilities, not about its name (spec F23a).
    ...(descriptor.issueCreates ? { issueCreates: descriptor.issueCreates } : {}),
  };
}
