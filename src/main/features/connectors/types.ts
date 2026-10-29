/**
 * Connector types (MCP-based).
 *
 * A connector instance = one configured MCP server connection. Same service can have multiple
 * instances (gmail-personal + gmail-work) with distinct ids. Tool calls flow through the MCP
 * client manager (`manager.ts`); the tool schema cache lives on the instance so the LLM tools[]
 * array can be assembled without waiting on a live server (cold-start instances surface a stale
 * cache; reconcile happens on first successful reconnect).
 */

export type Transport =
  | StdioTransport
  | StreamableHttpTransport;

export interface StdioTransport {
  kind: 'stdio';
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Representative external URL marks an app-owned child whose fetch calls
   * may use the parent Electron system network stack per request. */
  proxyTargetUrl?: string;
}

export interface StreamableHttpTransport {
  kind: 'streamable-http';
  url: string;
  headers?: Record<string, string>;
}

export interface ToolSchema {
  /** Tool name as reported by the MCP server (unprefixed). */
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** Connector status. Every value records an outcome that actually happened — no state here is
 *  ever synthesized from a cache to keep a card green (that is what made a dead connector render
 *  as "connected" for six days while every tool call failed).
 *
 *  Two orthogonal questions must not be conflated, because they have different answers:
 *    - "should we keep routing/retrying this connector?" → `connected` OR `degraded` (see
 *      `isConnectorUsable`). A transient backend hiccup must not hide the connector from the LLM,
 *      or it never gets a tool call and can never auto-heal.
 *    - "is it verified working right now?" → `connected` only (see `isConnectorVerifiedLive`).
 *      This is what the UI pill must render.
 *  Collapsing both onto one `connected` boolean is what forced the old code to lie. */
export type ConnectorStatus =
  | { kind: 'connected'; since: number }
  | { kind: 'connecting' }
  | { kind: 'disconnected' }
  /** Grant + cached tools are established, but the last connect/refresh attempt failed for a
   *  reason we expect to recover (backend 5xx, network blip). Still routed and retried on the next
   *  use; rendered as "未验证/异常" — never as connected. `last_verified_at` is the `since` of the
   *  last real successful connect, so the UI can say how stale the connector is.
   *
   *  `failures` / `retry_after` are the circuit breaker (see `manager.ts::_retryAfterFor`). Each
   *  connect attempt is individually bounded (3 tries inside `postConnectorBridgeJson`), but
   *  nothing used to bound attempts *across* calls: every tool call re-ran the whole refresh, so an
   *  agent turn against a dead backend fired 3 requests per call, indefinitely, and an app restart
   *  began again from zero. These two fields are persisted precisely so a cooldown survives restart. */
  | {
    kind: 'degraded';
    message: string;
    at: number;
    last_verified_at?: number;
    /** Consecutive transient failures. Reset by any success (the status becomes `connected`). */
    failures?: number;
    /** Epoch ms before which automatic reconnects must fail fast without touching the network.
     *  User-initiated retries deliberately ignore this. */
    retry_after?: number;
  }
  | { kind: 'error'; message: string; at: number };

/** Should this connector still be routed to the LLM and retried on use?
 *  `degraded` stays usable on purpose: the next tool call is what heals it. */
export function isConnectorUsable(status: ConnectorStatus | undefined): boolean {
  return status?.kind === 'connected' || status?.kind === 'degraded';
}

/** Did the last attempt actually succeed? This — and only this — may render as "已连接". */
export function isConnectorVerifiedLive(status: ConnectorStatus | undefined): boolean {
  return status?.kind === 'connected';
}

export interface ConnectorAuthError {
  code: string;
  message: string;
  reason?: string;
  at: number;
}

export interface ConnectorInstance {
  /** Stable id chosen by the user at install time (e.g. "github-personal"). Becomes the prefix on
   *  every tool name emitted into the AgentRunner tool list: `<id>__<tool_name>`. */
  id: string;
  display_name: string;
  /** Where the instance came from. Missing/undefined = 'catalog' (pre-existing rows).
   *  'custom' = user-supplied MCP server (id always carries the `custom-` prefix so it can
   *  never collide with a catalog entry id); its transport is used verbatim — no catalog
   *  template, no OAuth grant, no server-side refresh. See
   *  docs/plans/open-ecosystem-architecture.md §C. */
  origin?: 'catalog' | 'custom';
  transport: Transport;
  /** Tool subset to expose. `null` = all reported tools; `string[]` = whitelist of tool names. */
  enabled_subtools: string[] | null;
  /** Last-known tool schemas; used to assemble the LLM tools[] array without waiting for live
   *  reconnect. Refreshed on every successful `list_tools` call. */
  tools_cache: ToolSchema[];
  tools_cached_at: number;
  status: ConnectorStatus;
  /** Sticky non-sensitive auth failure marker. When a provider has definitively
   *  rejected a grant, boot/list/refresh paths must not keep retrying it. */
  auth_error?: ConnectorAuthError;
  /** OAuth grant when this instance was created via OAuth; absent for API-key installs.
   *  The manager rewrites the transport env at spawn time using `oauth_grant.access_token`;
   *  refresh logic in `oauth.ts::refreshIfStale` runs before connect / after a 401. */
  oauth_grant?: OAuthGrant;
  /** DCR-issued client identity for MCP-spec auth (`auth_mode === 'mcp_dcr'`). The public build
   *  stores this with the grant inside the encrypted local registry and never uploads it to the
   *  CogSeed account service. */
  dcr_client?: DcrClientCredentials;
  created_at: string;
  updated_at: string;
}

export interface ConnectorsFile {
  version: 2;
  connections: Record<string, ConnectorInstance>;
  oauth_hints?: Record<string, { reauthorize?: boolean }>;
  _deleted_at?: Record<string, string>;
}

export interface NewInstanceInput {
  id: string;
  display_name: string;
  transport: Transport;
  enabled_subtools?: string[] | null;
}

// ── Catalog ─────────────────────────────────────────────────────────────
// The UI doesn't accept arbitrary MCP server URLs / commands. Every connector the user can
// install is one of these curated entries. **Every entry uses OAuth 2.0** — no API-key fallback
// in the user-facing surface. (If we ever need a non-OAuth provider for an internal/enterprise
// case, that's a separate Phase 2 admin path, not in the curated catalog.)

export type TransportTemplate =
  | {
      kind: 'stdio';
      command: string;
      args: string[];
      /** The env var name to receive the bearer access_token at spawn time.
       *  Mutually exclusive with `env_synthesizer` — pick one. */
      oauth_env_key?: string;
      /** Optional callback name resolved in `apply-template.ts` for MCP servers whose env shape
       *  isn't a flat one-key map (Notion's `OPENAPI_MCP_HEADERS` packs a token into a JSON
       *  blob). The synthesizer receives the resolved `access_token`. */
      env_synthesizer?: string;
      /** Representative API URL opting an app-owned stdio adapter into the
       * parent's per-request system-network fetch bridge. */
      proxy_target_url?: string;
    }
  | {
      kind: 'streamable-http';
      url: string;
      /** HTTP header name for the bearer (defaults to `Authorization: Bearer <token>`). */
      oauth_header_key?: string;
      /** Scheme prefixed to the token. Defaults to `Bearer`; set to `''` for a provider that wants
       *  the raw credential in the header. Tencent Docs is the case in hand — its configuration
       *  guide specifies `"Authorization": "<token>"` and the published `qqdocs` client sends the
       *  token unprefixed, so a `Bearer ` prefix authenticates as nothing. */
      oauth_header_scheme?: string;
    };

// ── Auth ────────────────────────────────────────────────────────────────
// Three auth_modes for catalog entries. The first two are credential-forwarding: CogSeed obtains
// a grant and hands the token to the spawned MCP server. The third is credential-owning: the
// child resolves its own account and CogSeed never sees, stores, or forwards a token.
//
//  - 'server_bridge'  — CogSeed company pre-registered an OAuth App at the provider. Server holds
//    client_id/secret, runs the full OAuth handshake server-side, returns a token via deep-link.
//    Used when the provider doesn't ship a public MCP authorization server (e.g. GitHub Copilot
//    MCP today). Carries `oauth.provider_id` pointing at the Server's
//    `biz/connectors/oauth/<provider>.py` module.
//
//  - 'mcp_dcr'        — Provider hosts an MCP-spec OAuth authorization server. Client (PC)
//    self-registers via Dynamic Client Registration (RFC 7591) at runtime, runs the OAuth
//    handshake from PC, uses the `/api/connectors/oauth/dcr-callback` Server endpoint **only**
//    as an HTTPS callback intermediate (Server stashes code+state in a 5-min KV, deep-links
//    PC). The DCR client and rotating refresh grant remain encrypted on this device; Server is
//    never a credential store for this mode. Used for Notion, Atlassian, Cloudflare suite, … .
//
//  - 'local_cli'      — The provider publishes no OAuth authorization server at all; its
//    supported programmatic surface is a locally installed CLI that owns its own login (device
//    flow, OS keychain). CogSeed ships a stdio adapter under `bin/` that wraps that CLI, and the
//    adapter child runs the login and holds the session — so this mode needs **no** `oauth`
//    config, **no** `required_oauth_scopes`, and no grant. `transport_template` must therefore be
//    a stdio template that names neither `oauth_env_key` nor `env_synthesizer` (see
//    `apply-template.ts`, which only asserts a token for the forwarding shapes).
//
//    Why this stays inside the public-connector boundary (see
//    `test/main/features/connectors/open-source-boundary.test.ts`): the CLI is a publicly
//    obtainable, openly licensed package that any user can install themselves. No company-held
//    secret, no pre-registration, and no credit metering is involved — the credential lives in
//    the user's own OS keychain and never transits CogSeed. What changes is only *how* the user
//    authorizes, not *who can*.
//
//    Two consequences reviewers must keep in mind:
//      1. The CLI session is per-machine, not per-instance — `_resolveTransport(uid, inst)` is
//         keyed by instance, but every profile on the machine shares one CLI login. Disconnect
//         therefore means "log the CLI out" and affects all profiles, which is why the
//         disconnect path for this mode must confirm with the user first.
//      2. Availability is machine-dependent: the card must render as unavailable (not
//         "connectable, then fails") when the CLI is missing — hence
//         `unavailable_reason: 'cli_not_installed'`.
//
//  - 'interactive_token' — The provider publishes neither an MCP-spec OAuth authorization
//    server nor a CLI: it hands the user a credential through its own console or a custom
//    (non-RFC-6749) interactive flow. CogSeed collects that credential, materializes the
//    transport template with it, and stores the result inside the same per-instance
//    `secrets_enc` blob every other credential lives in — so the token never leaves this
//    device and there is no grant to refresh (`applyTemplate` is fed a bare `access_token`).
//    Re-authorization means re-supplying the credential, which replaces the stored transport.
//
//    Why this stays inside the public-connector boundary (see
//    `test/main/features/connectors/open-source-boundary.test.ts`): the credential is issued by
//    the provider to the user themselves. CogSeed holds no client secret, pre-registers
//    nothing, and meters nothing, and the user can revoke the credential in the provider's own
//    console. Same class as `local_cli`, except the token transits CogSeed's encrypted local
//    store instead of the provider's own keychain.

export interface OAuthConfig {
  /** Server-bridge only: matches the Server's `biz/connectors/oauth/<provider>.py` module name
   *  and the `/connectors/oauth/<provider>/start` URL path segment. */
  provider_id: string;
}

/** Dynamic Client Registration result (RFC 7591) for MCP-spec OAuth providers. Stored locally
 *  with the connector's encrypted secrets. All endpoints are captured at first connect —
 *  re-discovery on every refresh would add latency and assumes stable provider endpoints. */
export interface DcrClientCredentials {
  client_id: string;
  /** Most providers issue one; some omit (public clients). */
  client_secret?: string;
  /** How the provider expects client credentials on token requests. */
  token_endpoint_auth_method?: 'client_secret_post' | 'client_secret_basic' | 'none';
  /** Captured from provider discovery — kept for refresh + revoke later. */
  authorization_endpoint: string;
  token_endpoint: string;
  /** Optional; used for revoke / re-registration (rarely needed). */
  registration_endpoint?: string;
  /** RFC 8707 canonical resource URI (from PRM `resource` field). MUST be sent on every
   *  authorize / token / refresh request so the issued access_token is audience-bound to this
   *  MCP server; without it the MCP server rejects the token at the first protected request
   *  with `invalid_token`. */
  resource?: string;
}

export interface OAuthGrant {
  /** Current bearer token. */
  access_token: string;
  /** Long-lived rotation token; null when provider doesn't issue one. */
  refresh_token: string | null;
  /** Server-owned grant reference. Used by providers with rotating refresh tokens. */
  server_grant_id?: string;
  /** True when the refresh token is intentionally held by CogSeed Server, not this PC. */
  server_managed?: boolean;
  /** Unix ms when `access_token` expires; null when provider doesn't say. */
  expires_at: number | null;
  /** Granted scope list (whatever the provider actually returned). */
  scopes: string[];
  /** Provider-returned token_type — usually 'Bearer'. */
  token_type: string;
  /** Optional human-readable label (e.g. the email associated with the grant). Filled by
   *  per-provider modules' `fetch_account_label()` after exchange. */
  account_label?: string;
}

export type CatalogCategory =
  | 'developer'
  | 'productivity'
  | 'communication'
  | 'search'
  | 'data';

// credentials: UI-owned password/app-password, encrypted per user and instance.
// provider_device: provider-owned init/poll protocol, no application secret or DCR registration.
export type AuthMode = 'server_bridge' | 'mcp_dcr' | 'local_cli' | 'credentials' | 'provider_device' | 'interactive_token';

/** How an `interactive_token` entry obtains its credential.
 *
 *  Two variants ship, each with a provider that needs it — a variant with no user is dead contract
 *  surface and does not belong here:
 *
 *   - `paste`        — the provider issues the token in its own console and the user pastes it.
 *   - `browser_poll` — the provider runs a bespoke (non-RFC-6749) consent flow: the client opens a
 *                      consent URL carrying a `code` it generated, the user approves in a browser,
 *                      and the client polls an exchange endpoint with that same `code` until a token
 *                      appears. `dsh-wps` documents exactly this shape for WPS SkillHub.
 *
 *  The credential always lands in the instance's encrypted `secrets_enc` blob — see the
 *  `// ── Auth ──` section above for why that stays inside the public-connector boundary. */
export type InteractiveTokenAuth =
  | {
      kind: 'paste';
      /** Where the user obtains the credential. Rendered as the "获取令牌" help link in the connect
       *  dialog so the user is never asked for a token without being told where it comes from. */
      token_url?: string;
    }
  | {
      kind: 'browser_poll';
      /** Consent page, opened with `?auth_code=<generated>`. */
      authorize_url: string;
      /** POSTed `{ code }` on the poll until it answers with a token. */
      exchange_url: string;
      /** Poll cadence. WPS's own client uses 1s. */
      poll_interval_ms?: number;
      /** Give up after this long (WPS's own client uses 5 minutes). */
      timeout_ms?: number;
      /** JSON field holding the token in the exchange response. Defaults to `access_token`, then
       *  `token`, then `data.access_token` — providers in this family are inconsistent. */
      token_field?: string;
    };

export interface CatalogEntry {
  /** Stable id; doubles as the installed instance id (one install per catalog entry in Phase 0).
   *  Lowercase, [a-z0-9_-]+; used as the `<inst>__<tool>` prefix. */
  id: string;
  display_name: string;
  /** Inline SVG markup for the brand logo (or use `icon_name` for a shared Renderer icon).
   *  Use a square viewBox and omit fixed width/height so card CSS controls the rendered size:
   *  a 32×32 slot with 6px padding (20×20 artwork; Sentry uses 4px padding).
   *
   *  Optional only so `_entryFromInstance` (orphan-instance fallback when the catalog entry
   *  was removed but the install still exists) can omit it; the orphan path renders the
   *  display_name initials on a neutral gray placeholder. */
  icon_svg?: string;
  /** Shared Renderer icon for app-owned connector entries. */
  icon_name?: string;
  category: CatalogCategory;
  description_zh: string;
  description_en: string;
  /** Which authorization pathway this provider needs — see the `// ── Auth ──` section above. */
  auth_mode: AuthMode;
  /** Required when `auth_mode === 'server_bridge'`; absent for `'mcp_dcr'` (no pre-registration)
   *  and for `'local_cli'` (the adapter child owns the credential, so there is nothing to
   *  pre-register and no grant to obtain). */
  oauth?: OAuthConfig;
  /** Required when `auth_mode === 'interactive_token'`: how the user supplies the credential.
   *  Absent for every other mode (OAuth modes fetch their own grant; `local_cli` owns one). */
  interactive_auth?: InteractiveTokenAuth;
  /** OAuth scopes that must be present in the provider's returned grant for the connector to
   *  function. Google lets users uncheck individual requested permissions on the consent screen;
   *  when that happens the token exchange still succeeds but downstream APIs fail with 403s.
   *  Entries that set this are rejected immediately after OAuth if any required scope is absent. */
  required_oauth_scopes?: string[];
  /** MCP server config + how the access_token maps into env / headers. Null when this entry is
   *  catalogued but not yet installable (we don't have an MCP server target for it yet).
   *  Renderer surfaces a disabled "敬请期待" state. */
  transport_template: TransportTemplate | null;
  /** How the user gets this connector working, shown in the detail panel before/while connecting.
   *
   *  Product content, in the same spirit as `description_zh` / `description_en`: an enterprise user
   *  who has never seen a vendor CLI cannot be asked to guess `npm install -g @larksuite/cli`, and a
   *  connector that only says "缺少 CLI" or opens a bare token box is a dead end. Entries that omit
   *  this fall back to the generic chrome text, so nothing regresses. */
  setup?: {
    /** Command the user runs themselves when the CLI is missing (`local_cli`). Rendered verbatim
     *  with a copy button — never executed by us. */
    install_command?: string;
    /** Ordered, imperative steps for the whole onboarding. Keep each step to one action. */
    steps_zh: string[];
    steps_en: string[];
    /** Where the credential comes from, or the provider's own docs. Opened in the browser. */
    docs_url?: string;
    /** Short label for `docs_url`; defaults to a generic "查看官方文档". */
    docs_label_zh?: string;
    docs_label_en?: string;
    /** One-line explanation of what happens to the credential, shown next to the steps. */
    credential_note_zh?: string;
    credential_note_en?: string;
  };
  /** Set when `transport_template` is null to explain why; renderer surfaces in the badge. */
  unavailable_reason?: 'oauth_pending' | 'cli_not_installed';
  /** Remote-config gate. `visible_disabled` keeps the card visible but blocks OAuth/tool use. */
  availability?: 'visible_disabled';
  /** Why a `visible_disabled` card is disabled. `unsupported` = remote config said so;
   *  `cli_missing` = this machine does not have the `local_cli` connector's CLI installed, which
   *  the user can fix themselves, so the card must say so instead of the generic message. */
  disabled_reason?: 'unsupported' | 'cli_missing';
  runtime_installable?: boolean;
  runtime_progress?: { phase: 'downloading' | 'verifying' | 'installing'; percent?: number };
  /** When set, this catalog entry is a **UI-only bundle**: one OAuth flow provisions N member
   *  ConnectorInstances (one per listed catalog id). The bundle entry itself does NOT produce a
   *  ConnectorInstance and has `transport_template: null` — the model sees the members as
   *  independent connectors with their own tools. Renderer shows a single bundle card and
   *  hides the member entries. The bundle's OAuth `catalog_id` triggers the server-side
   *  scope-union path (e.g. `google-workspace` requests all 5 Google service scopes at once),
   *  and the manager clones the resulting grant into each member instance. See
   *  `manager.ts::connectViaOAuth`. */
  bundle_member_ids?: string[];
}
