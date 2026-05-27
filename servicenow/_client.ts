import { z } from "npm:zod@4.3.6";

/**
 * Shared ServiceNow REST client and OAuth helpers for extension models.
 *
 * Credentials are passed via globalArguments, typically resolved from vault:
 *   instanceUrl:  ${{ vault.get(<client-vault>, instance-url) }}
 *   clientId:     ${{ vault.get(<client-vault>, client-id) }}
 *   clientSecret: ${{ vault.get(<client-vault>, client-secret) }}
 *
 * Auth: OAuth 2.0 client_credentials grant against {instanceUrl}/oauth_token.do.
 * The instance must have `glide.oauth.inbound.client.credential.grant_type.enabled`
 * set to true for the grant flow to succeed.
 */

export const ServicenowGlobalArgsSchema = z.object({
  instanceUrl: z.string().describe(
    "ServiceNow instance base URL (e.g., https://venXXXXX.service-now.com). Use: ${{ vault.get(<client-vault>, instance-url) }}",
  ),
  clientId: z.string().meta({ sensitive: true }).describe(
    "OAuth client ID. Use: ${{ vault.get(<client-vault>, client-id) }}",
  ),
  clientSecret: z.string().meta({ sensitive: true }).describe(
    "OAuth client secret. Use: ${{ vault.get(<client-vault>, client-secret) }}",
  ),
  scope: z
    .string()
    .optional()
    .describe(
      "OAuth scope value (defaults to 'useraccount' which matches the standard ServiceNow inbound integration scope)",
    ),
});

export type ServicenowGlobalArgs = z.infer<typeof ServicenowGlobalArgsSchema>;

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

let cachedToken: CachedToken | null = null;

/**
 * Acquire an OAuth access token via client_credentials grant.
 * Caches the token within the current process for its lifetime; subsequent
 * calls within the same execution reuse the cached value until ~60s before expiry.
 */
export async function getAccessToken(
  globalArgs: ServicenowGlobalArgs,
): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60_000) {
    return cachedToken.accessToken;
  }

  const tokenUrl = `${
    stripTrailingSlash(globalArgs.instanceUrl)
  }/oauth_token.do`;
  const body = new URLSearchParams();
  body.set("grant_type", "client_credentials");
  body.set("client_id", globalArgs.clientId);
  body.set("client_secret", globalArgs.clientSecret);
  if (globalArgs.scope) {
    body.set("scope", globalArgs.scope);
  }

  const resp = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
    },
    body: body.toString(),
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(
      `ServiceNow OAuth token request failed: ${resp.status} ${resp.statusText} — ${errBody}`,
    );
  }

  const json = await resp.json() as {
    access_token: string;
    expires_in: number;
    token_type: string;
    scope?: string;
  };

  cachedToken = {
    accessToken: json.access_token,
    expiresAt: now + (json.expires_in * 1000),
  };

  return json.access_token;
}

/**
 * Make a JSON REST call to the ServiceNow instance with bearer auth.
 * Resolves the OAuth token automatically.
 */
export async function snApi(
  path: string,
  globalArgs: ServicenowGlobalArgs,
  options?: {
    method?: string;
    body?: unknown;
    params?: Record<string, string | undefined>;
    contentType?: string;
  },
): Promise<unknown> {
  const token = await getAccessToken(globalArgs);
  const url = new URL(
    path.startsWith("/") ? path : `/${path}`,
    stripTrailingSlash(globalArgs.instanceUrl),
  );
  if (options?.params) {
    for (const [k, v] of Object.entries(options.params)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, v);
    }
  }

  const headers: Record<string, string> = {
    "Authorization": `Bearer ${token}`,
    "Accept": "application/json",
  };

  const fetchOptions: RequestInit = {
    method: options?.method || "GET",
    headers,
  };

  if (options?.body !== undefined) {
    headers["Content-Type"] = options.contentType || "application/json";
    fetchOptions.body = typeof options.body === "string"
      ? options.body
      : JSON.stringify(options.body);
  }

  const resp = await fetch(url.toString(), fetchOptions);

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(
      `ServiceNow API ${resp.status} ${resp.statusText} on ${
        options?.method || "GET"
      } ${url.pathname}: ${errBody}`,
    );
  }

  if (resp.status === 204) {
    return null;
  }

  const text = await resp.text();
  return text ? JSON.parse(text) : null;
}

/**
 * Build a Table API path for a given table.
 * @param table - sys_db_object name (e.g., "incident", "sys_user", "sys_app")
 * @param sysId - optional sys_id for single-record paths. If the parameter is
 *   provided as an explicit empty string, throws — empty sys_id silently
 *   falling through to a list path is a frequent caller bug (e.g., a parser
 *   that failed to extract a real id).
 */
export function tablePath(table: string, sysId?: string): string {
  if (sysId !== undefined && sysId === "") {
    throw new Error(
      `tablePath called with empty sys_id for table "${table}". A single-record operation needs a non-empty sys_id.`,
    );
  }
  const safeTable = encodeURIComponent(table);
  return sysId
    ? `/api/now/table/${safeTable}/${encodeURIComponent(sysId)}`
    : `/api/now/table/${safeTable}`;
}

/**
 * Build a Stats (aggregate) API path for a given table.
 */
export function statsPath(table: string): string {
  return `/api/now/stats/${encodeURIComponent(table)}`;
}

/**
 * Sanitize an arbitrary string for use as a swamp resource name.
 * Lowercase, hyphen-separated, alphanumeric only.
 */
export function sanitizeName(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(
    /^-+|-+$/g,
    "",
  ).slice(0, 80) || "unnamed";
}

/**
 * Ensure sys_id is included in a sysparm_fields list. Resource names depend on
 * sys_id for uniqueness, so we always retrieve it even if the caller did not
 * request it. Returns undefined if no field list was specified (all fields).
 */
export function ensureSysIdField(fields?: string): string | undefined {
  if (!fields) return undefined;
  const parts = fields.split(",").map((s) => s.trim()).filter(Boolean);
  if (!parts.includes("sys_id")) parts.push("sys_id");
  return parts.join(",");
}

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}
