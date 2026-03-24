// ---------------------------------------------------------------------------
// ClawNet REST API client.
//
// Pure TypeScript module with zero plugin SDK dependencies. The worker injects
// `ctx.http.fetch` and the resolved API key at runtime via the factory config.
//
// Endpoints consumed (from ClawNet registry Phase 1.4):
//   GET  /api/v1/agents          — paginated agent list
//   GET  /api/v1/agents/:slug    — single agent with latest version
//   GET  /api/v1/skills          — paginated skill list
//   GET  /api/v1/search          — vector + keyword search across types
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Domain types — derived from the ClawNet Convex schema (agents, agentVersions,
// skills, skillVersions tables).
// ---------------------------------------------------------------------------

/** A file bundled with an agent or skill version. */
export interface ClawNetBundledFile {
  path: string;
  content: string;
}

/** An agent record as returned by the ClawNet registry. */
export interface ClawNetAgent {
  _id: string;
  slug: string;
  name: string;
  displayName: string;
  description: string;
  model: string;
  color: string;
  icon?: string;
  category?: string;
  authorBapId: string;
  latestVersion: string;
  latestTxId?: string;
  homepage?: string;
  tags?: string[];
  deleted: boolean;
  starCount: number;
  downloadCount: number;
  downloadCountAllTime: number;
  createdAt: number;
  updatedAt: number;
}

/** A specific version of an agent. */
export interface ClawNetAgentVersion {
  _id: string;
  slug: string;
  version: string;
  content: string;
  contentType: string;
  systemPrompt: string;
  skills?: string[];
  files?: ClawNetBundledFile[];
  authorBapId: string;
  changelog?: string;
  publishedAt: number;
  onChain: boolean;
  txId?: string;
  aipSignature?: string;
  signerAddress?: string;
  opReturnHex?: string;
  manifestOutpoint?: string;
  packageOutputs?: string;
  manifestVout?: number;
  packageType?: string;
}

/** A skill record as returned by the ClawNet registry. */
export interface ClawNetSkill {
  _id: string;
  slug: string;
  name: string;
  displayName: string;
  description: string;
  authorBapId: string;
  latestVersion: string;
  latestTxId?: string;
  homepage?: string;
  tags?: string[];
  deleted: boolean;
  starCount: number;
  downloadCount: number;
  downloadCountAllTime: number;
  createdAt: number;
  updatedAt: number;
  language?: string;
}

export interface ClawNetOrganizationAgent {
  slug: string;
  role?: string;
  reportsTo?: string;
}

export interface ClawNetOrganization {
  _id: string;
  slug: string;
  name: string;
  displayName: string;
  description: string;
  authorBapId: string;
  agents: ClawNetOrganizationAgent[];
  skills?: string[];
  color?: string;
  icon?: string;
  homepage?: string;
  tags?: string[];
  latestTxId?: string;
  deleted: boolean;
  starCount: number;
  downloadCount: number;
  downloadCountAllTime: number;
  createdAt: number;
  updatedAt: number;
}

export interface ClawNetOrganizationListResponse {
  organizations: ClawNetOrganization[];
  hasMore: boolean;
  cursor?: string;
}

export interface ClawNetOrganizationDetailResponse {
  organization: ClawNetOrganization;
  resolvedAgents: Array<{
    slug: string;
    name: string;
    displayName: string;
    description: string;
    model: string;
    color: string;
    version: string;
    role?: string;
    reportsTo?: string;
  }>;
  resolvedSkills: Array<{
    slug: string;
    name: string;
    description: string;
    version: string;
  }>;
  author: { bapId: string; pubkey: string } | null;
}

// ---------------------------------------------------------------------------
// API response envelopes
// ---------------------------------------------------------------------------

export interface ClawNetListResponse<T> {
  agents?: T[];
  skills?: T[];
  hasMore: boolean;
  cursor?: string;
}

export interface ClawNetAgentListResponse {
  agents: ClawNetAgent[];
  hasMore: boolean;
  cursor?: string;
}

export interface ClawNetSkillListResponse {
  skills: ClawNetSkill[];
  hasMore: boolean;
  cursor?: string;
}

/** GET /api/v1/agents/:slug returns the agent + its latest version. */
export interface ClawNetAgentDetailResponse {
  agent: ClawNetAgent;
  latestVersion: ClawNetAgentVersion;
}

/** GET /api/v1/search returns mixed results with type discriminators. */
export interface ClawNetSearchResult {
  type: "agent" | "skill" | "organization";
  slug: string;
  displayName: string;
  description: string;
  score: number;
}

export interface ClawNetSearchResponse {
  results: ClawNetSearchResult[];
  hasMore: boolean;
  cursor?: string;
}

// ---------------------------------------------------------------------------
// Query parameter types
// ---------------------------------------------------------------------------

export type ClawNetSortOrder = "updated" | "newest" | "downloads" | "stars";

export interface ListAgentsParams {
  sort?: ClawNetSortOrder;
  limit?: number;
  cursor?: string;
  search?: string;
  author?: string;
}

export interface ListSkillsParams {
  sort?: ClawNetSortOrder;
  limit?: number;
  cursor?: string;
  search?: string;
  author?: string;
}

export interface SearchAllParams {
  query: string;
  type?: "agent" | "skill" | "organization" | "all";
  limit?: number;
  cursor?: string;
}

export interface ListOrganizationsParams {
  sort?: ClawNetSortOrder;
  limit?: number;
  cursor?: string;
  author?: string;
}

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

/**
 * Typed error thrown by the ClawNet API client. Captures the HTTP status,
 * the raw response body (if parseable), and a structured error code when
 * the server provides one.
 */
export class ClawNetApiError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly code?: string;
  readonly body?: Record<string, unknown>;

  constructor(
    status: number,
    statusText: string,
    body?: Record<string, unknown>,
  ) {
    const code = typeof body?.code === "string" ? body.code : undefined;
    const serverMessage = typeof body?.message === "string" ? body.message : undefined;
    const summary = serverMessage ?? `ClawNet API error ${status} ${statusText}`;
    super(summary);
    this.name = "ClawNetApiError";
    this.status = status;
    this.statusText = statusText;
    this.code = code;
    this.body = body;
  }
}

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

export interface ClawNetClientConfig {
  /** Base URL of the ClawNet registry (e.g. "https://clawnet.sh"). */
  baseUrl: string;

  /**
   * Fetch function injected by the caller. In the plugin worker this is
   * `ctx.http.fetch`; in tests it can be a stub.
   */
  fetchFn: (url: string, init?: RequestInit) => Promise<Response>;

  /** Optional Bearer token for authenticated endpoints (e.g. publishing). */
  apiKey?: string;
}

export interface ClawNetClient {
  /** GET /api/v1/agents — paginated agent list with optional filters. */
  listAgents(params?: ListAgentsParams): Promise<ClawNetAgentListResponse>;

  /** GET /api/v1/agents/:slug — full agent detail with latest version. */
  getAgent(slug: string): Promise<ClawNetAgentDetailResponse>;

  /** GET /api/v1/skills — paginated skill list with optional filters. */
  listSkills(params?: ListSkillsParams): Promise<ClawNetSkillListResponse>;

  /** GET /api/v1/search — vector + keyword search across agents and skills. */
  searchAll(query: string, type?: "agent" | "skill" | "organization" | "all"): Promise<ClawNetSearchResponse>;

  /** GET /api/v1/organizations — paginated organization list. */
  listOrganizations(params?: ListOrganizationsParams): Promise<ClawNetOrganizationListResponse>;

  /** GET /api/v1/organizations/:slug — full organization detail. */
  getOrganization(slug: string): Promise<ClawNetOrganizationDetailResponse>;

  /** GET /api/v1/apps — paginated app list. */
  listApps(params?: ListOrganizationsParams): Promise<{ apps: ClawNetOrganization[]; hasMore: boolean; cursor?: string }>;
}

/**
 * Creates a ClawNet API client. The caller supplies the fetch implementation
 * and optional API key — the client handles URL construction, headers, error
 * parsing, and response typing.
 *
 * @example
 * ```ts
 * const client = createClawNetClient({
 *   baseUrl: "https://clawnet.sh",
 *   fetchFn: ctx.http.fetch,
 *   apiKey: resolvedApiKey,
 * });
 * const { agents, hasMore } = await client.listAgents({ limit: 20 });
 * ```
 */
export function createClawNetClient(config: ClawNetClientConfig): ClawNetClient {
  const { baseUrl, fetchFn, apiKey } = config;

  // Normalise base URL — strip trailing slash
  const base = baseUrl.replace(/\/+$/, "");

  function buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    return headers;
  }

  function buildUrl(path: string, params?: Record<string, string | undefined>): string {
    const url = new URL(`${base}${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== "") {
          url.searchParams.set(key, value);
        }
      }
    }
    return url.toString();
  }

  async function request<T>(path: string, params?: Record<string, string | undefined>): Promise<T> {
    const url = buildUrl(path, params);
    const response = await fetchFn(url, {
      method: "GET",
      headers: buildHeaders(),
    });

    if (!response.ok) {
      let body: Record<string, unknown> | undefined;
      try {
        body = (await response.json()) as Record<string, unknown>;
      } catch {
        // Response body is not JSON — leave body undefined.
      }
      throw new ClawNetApiError(response.status, response.statusText, body);
    }

    return (await response.json()) as T;
  }

  return {
    async listAgents(params?: ListAgentsParams): Promise<ClawNetAgentListResponse> {
      return request<ClawNetAgentListResponse>("/api/v1/agents", {
        sort: params?.sort,
        limit: params?.limit !== undefined ? String(params.limit) : undefined,
        cursor: params?.cursor,
        search: params?.search,
        author: params?.author,
      });
    },

    async getAgent(slug: string): Promise<ClawNetAgentDetailResponse> {
      if (!slug) {
        throw new Error("slug is required");
      }
      return request<ClawNetAgentDetailResponse>(
        `/api/v1/agents/${encodeURIComponent(slug)}`,
      );
    },

    async listSkills(params?: ListSkillsParams): Promise<ClawNetSkillListResponse> {
      return request<ClawNetSkillListResponse>("/api/v1/skills", {
        sort: params?.sort,
        limit: params?.limit !== undefined ? String(params.limit) : undefined,
        cursor: params?.cursor,
        search: params?.search,
        author: params?.author,
      });
    },

    async searchAll(query: string, type?: "agent" | "skill" | "organization" | "all"): Promise<ClawNetSearchResponse> {
      if (!query) {
        throw new Error("query is required");
      }
      return request<ClawNetSearchResponse>("/api/v1/search", {
        query,
        type: type ?? "all",
      });
    },

    async listOrganizations(params?: ListOrganizationsParams): Promise<ClawNetOrganizationListResponse> {
      return request<ClawNetOrganizationListResponse>("/api/v1/organizations", {
        sort: params?.sort,
        limit: params?.limit !== undefined ? String(params.limit) : undefined,
        cursor: params?.cursor,
        author: params?.author,
      });
    },

    async getOrganization(slug: string): Promise<ClawNetOrganizationDetailResponse> {
      if (!slug) throw new Error("slug is required");
      return request<ClawNetOrganizationDetailResponse>(
        `/api/v1/organizations/${encodeURIComponent(slug)}`,
      );
    },

    async listApps(params?: ListOrganizationsParams): Promise<{ apps: ClawNetOrganization[]; hasMore: boolean; cursor?: string }> {
      return request<{ apps: ClawNetOrganization[]; hasMore: boolean; cursor?: string }>("/api/v1/apps", {
        sort: params?.sort,
        limit: params?.limit !== undefined ? String(params.limit) : undefined,
        cursor: params?.cursor,
        author: params?.author,
      });
    },
  };
}
