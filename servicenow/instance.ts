import { z } from "npm:zod@4.3.6";
import {
  ensureSysIdField,
  sanitizeName,
  ServicenowGlobalArgsSchema,
  snApi,
  statsPath,
  tablePath,
} from "./_client.ts";

/**
 * `@dougschaefer/servicenow-instance` — General-purpose ServiceNow integration model.
 *
 * Phase 1 surface: instance metadata, generic Table API CRUD, aggregate queries,
 * and a passthrough REST call for endpoints outside the Table API. Designed as the
 * foundation for spoke development, administration, and ad-hoc data analysis on a
 * ServiceNow instance.
 *
 * Auth: OAuth 2.0 client_credentials grant. The instance must have
 * `glide.oauth.inbound.client.credential.grant_type.enabled` set to true and the
 * OAuth Application Registry record must be bound to a user (the token impersonates
 * that user, inheriting their roles and ACLs).
 */

const InstanceInfoSchema = z.object({
  instanceUrl: z.string(),
  productName: z.string().optional(),
  buildTag: z.string().optional(),
  warFile: z.string().optional(),
  scopePrefix: z.string().optional(),
  currentUser: z
    .object({
      sysId: z.string(),
      userName: z.string(),
      name: z.string(),
      roles: z.string(),
    })
    .optional(),
  capturedAt: z.string(),
}).passthrough();

const RecordSchema = z.object({
  table: z.string(),
  sysId: z.string(),
  record: z.record(z.string(), z.unknown()),
  capturedAt: z.string(),
}).passthrough();

const AggregateSchema = z.object({
  table: z.string(),
  query: z.string().optional(),
  result: z.unknown(),
  capturedAt: z.string(),
}).passthrough();

const RestResponseSchema = z.object({
  method: z.string(),
  path: z.string(),
  status: z.number(),
  response: z.unknown(),
  capturedAt: z.string(),
}).passthrough();

const OAuthProviderSchema = z.object({
  instanceUrl: z.string(),
  name: z.string(),
  entitySysId: z.string(),
  profileSysId: z.string(),
  scopes: z.array(z.object({ name: z.string(), sysId: z.string() })),
  secretSet: z.boolean(),
  nextSteps: z.array(z.string()),
  capturedAt: z.string(),
}).passthrough();

const OAuthAccountSchema = z.object({
  instanceUrl: z.string(),
  accountName: z.string(),
  credentialSysId: z.string(),
  connectionSysId: z.string(),
  registryRowSysId: z.string().optional(),
  getTokenUrl: z.string(),
  nextSteps: z.array(z.string()),
  capturedAt: z.string(),
}).passthrough();

type SnContext = {
  globalArgs: z.infer<typeof ServicenowGlobalArgsSchema>;
  logger: { info: (msg: string, vars?: Record<string, unknown>) => void };
  writeResource: (
    type: string,
    name: string,
    data: unknown,
  ) => Promise<unknown>;
};

/**
 * `@dougschaefer/servicenow-instance` model — ServiceNow integration
 * via the Table API using OAuth client_credentials with automatic
 * token caching. Lookup confirms instance reachability and records
 * version metadata for downstream verification. tableQuery enumerates
 * records using ServiceNow's encoded query language, tableGet fetches
 * a single record by sys_id, tableCreate inserts a new row,
 * tableUpdate mutates an existing row, and tableDelete removes one —
 * the full CRUD surface against any table the instance exposes
 * (incident, cmdb_ci, change_request, etc.). Credentials are
 * resolved from the vault; sys_id is always validated before
 * destructive operations.
 */
export const model = {
  type: "@dougschaefer/servicenow-instance",
  version: "2026.06.29.1",
  globalArguments: ServicenowGlobalArgsSchema,
  resources: {
    "instance-info": {
      description:
        "ServiceNow instance metadata snapshot — release, build, scope prefix, and the user identity the OAuth token impersonates",
      schema: InstanceInfoSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    record: {
      description:
        "A single record from a ServiceNow table — full field set as returned by the Table API, tagged with table name and sys_id",
      schema: RecordSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    aggregate: {
      description:
        "Result of a ServiceNow Aggregate API query — count/avg/sum/min/max/group_by output",
      schema: AggregateSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "rest-response": {
      description:
        "Response body from a generic ServiceNow REST call — for endpoints outside the Table API (Scripted REST APIs, Import APIs, custom application endpoints)",
      schema: RestResponseSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "oauth-provider": {
      description:
        "Summary of a third-party OAuth 2.0 provider stood up by setupOAuthProvider — the oauth_entity (Application Registry), its default profile, and the linked scopes, plus the remaining manual UI steps (Connection & Credential Alias + interactive token grant).",
      schema: OAuthProviderSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "oauth-account": {
      description:
        "A single per-account OAuth wiring created by addOAuthAccount — the OAuth 2.0 Credential (bound to the provider profile), the HTTP Connection (bound to the shared alias), and an optional operational-registry row, plus the interactive Get-OAuth-Token consent URL.",
      schema: OAuthAccountSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    lookup: {
      description:
        "Verify OAuth credentials, capture instance metadata (release, scope prefix), and identify the user the token impersonates. Run this first to confirm connectivity.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: SnContext) => {
        const props = await snApi(
          "/api/now/table/sys_properties",
          context.globalArgs,
          {
            params: {
              sysparm_query:
                "nameINglide.product.name,glide.buildtag,glide.war,glide.appcreator.company.code",
              sysparm_fields: "name,value",
            },
          },
        ) as { result: Array<{ name: string; value: string }> };

        const propMap = new Map(props.result.map((p) => [p.name, p.value]));

        const whoami = await snApi(
          "/api/now/table/sys_user",
          context.globalArgs,
          {
            params: {
              sysparm_query: "user_name=javascript:gs.getUserName()",
              sysparm_fields: "sys_id,user_name,name,roles",
              sysparm_limit: "1",
            },
          },
        ) as {
          result: Array<{
            sys_id: string;
            user_name: string;
            name: string;
            roles: string;
          }>;
        };

        const user = whoami.result[0];

        const info = {
          instanceUrl: context.globalArgs.instanceUrl,
          productName: propMap.get("glide.product.name"),
          buildTag: propMap.get("glide.buildtag"),
          warFile: propMap.get("glide.war"),
          scopePrefix: propMap.get("glide.appcreator.company.code"),
          currentUser: user
            ? {
              sysId: user.sys_id,
              userName: user.user_name,
              name: user.name,
              roles: user.roles,
            }
            : undefined,
          capturedAt: new Date().toISOString(),
        };

        context.logger.info(
          "Connected to {instanceUrl} as {user} (release={war})",
          {
            instanceUrl: info.instanceUrl,
            user: info.currentUser?.userName,
            war: info.warFile,
          },
        );

        const handle = await context.writeResource(
          "instance-info",
          sanitizeName(
            new URL(info.instanceUrl).hostname.replace(
              /\.service-now\.com$/,
              "",
            ),
          ),
          info,
        );
        return { dataHandles: [handle] };
      },
    },

    tableQuery: {
      description:
        "Query a ServiceNow table with an encoded query string. Returns matching records as resource artifacts. Use sysparm_query syntax (e.g., 'active=true^stateIN1,2^ORDERBYsys_created_on').",
      arguments: z.object({
        table: z.string().describe(
          "Table name (e.g., 'incident', 'sys_user', 'sys_app')",
        ),
        query: z.string().optional().describe(
          "Encoded query string (sysparm_query). Empty returns all records up to limit.",
        ),
        fields: z.string().optional().describe(
          "Comma-separated field list to retrieve (sysparm_fields). Defaults to all fields.",
        ),
        limit: z.coerce.number().int().positive().optional().default(100)
          .describe("Maximum records to return (sysparm_limit). Default 100."),
        offset: z.coerce.number().int().nonnegative().optional().default(0)
          .describe("Pagination offset (sysparm_offset). Default 0."),
        displayValue: z
          .enum(["true", "false", "all"])
          .optional()
          .default("false")
          .describe(
            "How to render reference fields: 'false' returns sys_ids, 'true' returns display values, 'all' returns both.",
          ),
      }),
      execute: async (
        args: {
          table: string;
          query?: string;
          fields?: string;
          limit: number;
          offset: number;
          displayValue: "true" | "false" | "all";
        },
        context: SnContext,
      ) => {
        const fields = ensureSysIdField(args.fields);
        const params: Record<string, string | undefined> = {
          sysparm_query: args.query,
          sysparm_fields: fields,
          sysparm_limit: String(args.limit),
          sysparm_offset: String(args.offset),
          sysparm_display_value: args.displayValue,
        };
        const resp = await snApi(
          tablePath(args.table),
          context.globalArgs,
          { params },
        ) as { result: Array<Record<string, unknown>> };

        context.logger.info(
          "Fetched {count} record(s) from {table}",
          { count: resp.result.length, table: args.table },
        );

        const handles = [];
        const seen = new Set<string>();
        for (let i = 0; i < resp.result.length; i++) {
          const record = resp.result[i];
          const sysId = (record.sys_id as string) || "";
          const baseName = sysId
            ? sanitizeName(`${args.table}-${sysId.slice(-12)}`)
            : sanitizeName(`${args.table}-row-${i}`);
          let name = baseName;
          let suffix = 1;
          while (seen.has(name)) {
            name = `${baseName}-${suffix++}`;
          }
          seen.add(name);
          const handle = await context.writeResource("record", name, {
            table: args.table,
            sysId,
            record,
            capturedAt: new Date().toISOString(),
          });
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    tableGet: {
      description: "Fetch a single record from a ServiceNow table by sys_id.",
      arguments: z.object({
        table: z.string().describe("Table name"),
        sysId: z.string().min(1).describe("sys_id of the record"),
        fields: z.string().optional().describe(
          "Comma-separated field list (sysparm_fields). Defaults to all fields.",
        ),
        displayValue: z
          .enum(["true", "false", "all"])
          .optional()
          .default("false"),
      }),
      execute: async (
        args: {
          table: string;
          sysId: string;
          fields?: string;
          displayValue: "true" | "false" | "all";
        },
        context: SnContext,
      ) => {
        const resp = await snApi(
          tablePath(args.table, args.sysId),
          context.globalArgs,
          {
            params: {
              sysparm_fields: args.fields,
              sysparm_display_value: args.displayValue,
            },
          },
        ) as { result: Record<string, unknown> };

        context.logger.info("Fetched {table} record {sysId}", {
          table: args.table,
          sysId: args.sysId,
        });

        const name = sanitizeName(`${args.table}-${args.sysId.slice(-12)}`);
        const handle = await context.writeResource("record", name, {
          table: args.table,
          sysId: args.sysId,
          record: resp.result,
          capturedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    tableCreate: {
      description:
        "Insert a new record into a ServiceNow table. Pass field values as a JSON object.",
      arguments: z.object({
        table: z.string().describe("Table name"),
        fields: z.record(z.string(), z.unknown()).describe(
          "Field name → value object for the new record",
        ),
      }),
      execute: async (
        args: { table: string; fields: Record<string, unknown> },
        context: SnContext,
      ) => {
        const resp = await snApi(
          tablePath(args.table),
          context.globalArgs,
          { method: "POST", body: args.fields },
        ) as { result: Record<string, unknown> };

        const sysId = (resp.result.sys_id as string) || "";
        context.logger.info("Created {table} record {sysId}", {
          table: args.table,
          sysId,
        });

        const name = sanitizeName(`${args.table}-${sysId.slice(-12)}`);
        const handle = await context.writeResource("record", name, {
          table: args.table,
          sysId,
          record: resp.result,
          capturedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    tableUpdate: {
      description:
        "Update fields on an existing ServiceNow record. Uses HTTP PATCH semantics — only provided fields are changed.",
      arguments: z.object({
        table: z.string().describe("Table name"),
        sysId: z.string().min(1).describe("sys_id of the record to update"),
        fields: z.record(z.string(), z.unknown()).describe(
          "Field name → value object with only the fields to change",
        ),
      }),
      execute: async (
        args: {
          table: string;
          sysId: string;
          fields: Record<string, unknown>;
        },
        context: SnContext,
      ) => {
        const resp = await snApi(
          tablePath(args.table, args.sysId),
          context.globalArgs,
          { method: "PATCH", body: args.fields },
        ) as { result: Record<string, unknown> };

        context.logger.info("Updated {table} record {sysId}", {
          table: args.table,
          sysId: args.sysId,
        });

        const name = sanitizeName(`${args.table}-${args.sysId.slice(-12)}`);
        const handle = await context.writeResource("record", name, {
          table: args.table,
          sysId: args.sysId,
          record: resp.result,
          capturedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    tableDelete: {
      description:
        "Delete a record from a ServiceNow table by sys_id. Destructive — verify the sys_id with tableGet first.",
      arguments: z.object({
        table: z.string().describe("Table name"),
        sysId: z.string().min(1).describe("sys_id of the record to delete"),
      }),
      execute: async (
        args: { table: string; sysId: string },
        context: SnContext,
      ) => {
        await snApi(
          tablePath(args.table, args.sysId),
          context.globalArgs,
          { method: "DELETE" },
        );
        context.logger.info("Deleted {table} record {sysId}", {
          table: args.table,
          sysId: args.sysId,
        });
        return { dataHandles: [] };
      },
    },

    tableAggregate: {
      description:
        "Aggregate query against a ServiceNow table (count, sum, avg, min, max, group_by). Use this for data analysis without dragging full record sets across the wire.",
      arguments: z.object({
        table: z.string().describe("Table name"),
        query: z.string().optional().describe(
          "Encoded query (sysparm_query) to filter records before aggregation",
        ),
        count: z.boolean().optional().default(true).describe(
          "Include record count (sysparm_count)",
        ),
        avgFields: z.string().optional().describe(
          "Comma-separated numeric fields to average (sysparm_avg_fields)",
        ),
        sumFields: z.string().optional().describe(
          "Comma-separated numeric fields to sum (sysparm_sum_fields)",
        ),
        minFields: z.string().optional().describe(
          "Comma-separated numeric fields for minimum (sysparm_min_fields)",
        ),
        maxFields: z.string().optional().describe(
          "Comma-separated numeric fields for maximum (sysparm_max_fields)",
        ),
        groupBy: z.string().optional().describe(
          "Comma-separated fields to group by (sysparm_group_by)",
        ),
      }),
      execute: async (
        args: {
          table: string;
          query?: string;
          count?: boolean;
          avgFields?: string;
          sumFields?: string;
          minFields?: string;
          maxFields?: string;
          groupBy?: string;
        },
        context: SnContext,
      ) => {
        const params: Record<string, string | undefined> = {
          sysparm_query: args.query,
          sysparm_count: args.count ? "true" : undefined,
          sysparm_avg_fields: args.avgFields,
          sysparm_sum_fields: args.sumFields,
          sysparm_min_fields: args.minFields,
          sysparm_max_fields: args.maxFields,
          sysparm_group_by: args.groupBy,
        };
        const resp = await snApi(
          statsPath(args.table),
          context.globalArgs,
          { params },
        );

        context.logger.info("Aggregate query complete on {table}", {
          table: args.table,
        });

        const name = sanitizeName(
          `aggregate-${args.table}-${Date.now().toString(36)}`,
        );
        const handle = await context.writeResource("aggregate", name, {
          table: args.table,
          query: args.query,
          result: resp,
          capturedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    restCall: {
      description:
        "Generic REST call to any path on the ServiceNow instance. Use for Scripted REST APIs, Import APIs, application-specific endpoints, or anything outside the Table API. The OAuth token is applied automatically.",
      arguments: z.object({
        path: z.string().describe(
          "URL path on the instance (e.g., '/api/sn_chg_rest/change' or '/api/x_amsoe_app/widget')",
        ),
        method: z
          .enum(["GET", "POST", "PUT", "PATCH", "DELETE"])
          .optional()
          .default("GET"),
        body: z.unknown().optional().describe(
          "Request body for POST/PUT/PATCH (object will be JSON-serialized)",
        ),
        params: z.record(z.string(), z.string()).optional().describe(
          "Query string parameters",
        ),
      }),
      execute: async (
        args: {
          path: string;
          method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
          body?: unknown;
          params?: Record<string, string>;
        },
        context: SnContext,
      ) => {
        const resp = await snApi(args.path, context.globalArgs, {
          method: args.method,
          body: args.body,
          params: args.params,
        });

        context.logger.info("REST {method} {path} ok", {
          method: args.method,
          path: args.path,
        });

        const name = sanitizeName(
          `rest-${args.method}-${args.path}-${Date.now().toString(36)}`,
        );
        const handle = await context.writeResource("rest-response", name, {
          method: args.method,
          path: args.path,
          status: 200,
          response: resp,
          capturedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    setupOAuthProvider: {
      description:
        "Fan-out: stand up a third-party OAuth 2.0 provider for an integration spoke in one execution (one model-lock acquisition). Creates the oauth_entity (Application Registry record), its default oauth_entity_profile, all oauth_entity_scope records (name + oauth_entity_scope both set), the profile↔scope m2m links, and optionally a shared Connection & Credential Alias — replacing ~3+N manual Table API calls. Set sysScope to land every record inside a scoped app (verified: sys_scope sticks on oauth_entity via the Table API; the auto-created default profile inherits it). The client_secret is NOT set here: client_secret is a password2 (encrypted) field, and the Table API does not encrypt it the way the SN UI password field does — a Table-API-written secret is malformed and the provider rejects the token exchange with 401 invalid_client. Enter the secret once in the SN UI password field (returned as a nextStep). Does NOT trigger the interactive token grant (browser consent). Use addOAuthAccount for the per-account credential + connection + token grant.",
      arguments: z.object({
        name: z.string().min(1).describe(
          "Display name for the OAuth provider (Application Registry record), e.g. 'Webex Spoke Integration'",
        ),
        authUrl: z.string().describe(
          "Provider authorization endpoint URL (e.g., https://webexapis.com/v1/authorize)",
        ),
        tokenUrl: z.string().describe(
          "Provider token endpoint URL (e.g., https://webexapis.com/v1/access_token)",
        ),
        providerClientId: z.string().meta({ sensitive: true }).describe(
          "OAuth client_id to configure on the provider. Named providerClientId (not clientId) to avoid collision with the model's global clientId. Use: ${{ vault.get(<vault>, <client-id-key>) }}",
        ),
        scopes: z.array(z.string()).min(1).describe(
          "List of OAuth scope strings to request (each becomes an oauth_entity_scope linked to the profile)",
        ),
        grantType: z.string().optional().default("authorization_code").describe(
          "OAuth grant type (default authorization_code)",
        ),
        usePkce: z.boolean().optional().default(true).describe(
          "Enable PKCE (default true)",
        ),
        codeChallengeMethod: z.string().optional().default("S256").describe(
          "PKCE code challenge method (default S256)",
        ),
        sendCredentialsAs: z
          .string()
          .optional()
          .default("request_body_parameter")
          .describe(
            "How client credentials are sent to the token endpoint: 'request_body_parameter' or 'basic_auth_header' (default request_body_parameter)",
          ),
        sysScope: z.string().optional().describe(
          "Scoped application sys_id to create the provider records IN. Omit for global scope. When set, sys_scope + sys_package are stamped on the oauth_entity, its oauth_entity_scope rows, and the profile↔scope m2m links so the provider ships as part of the scoped app. (Platform OAuth tables can be stricter about cross-scope writes than ordinary tables — verify the entity's resulting sys_scope after creation.)",
        ),
        redirectUrl: z.string().optional().describe(
          "Explicit redirect_url for the oauth_entity. Omit to let ServiceNow auto-generate (…/oauth_redirect.do). Set it when the provider's pre-registered redirect must match exactly.",
        ),
        connectionAliasName: z.string().optional().describe(
          "If set, also create a shared Connection & Credential Alias (sys_alias: type=connection, connection_type=http_connection, multiple_connections=true) with this name/id — the alias that per-account connections attach to (see addOAuthAccount). Returned as aliasSysId.",
        ),
      }),
      execute: async (
        args: {
          name: string;
          authUrl: string;
          tokenUrl: string;
          providerClientId: string;
          scopes: string[];
          grantType: string;
          usePkce: boolean;
          codeChallengeMethod: string;
          sendCredentialsAs: string;
          sysScope?: string;
          redirectUrl?: string;
          connectionAliasName?: string;
        },
        context: SnContext,
      ) => {
        // When targeting a scoped app, stamp sys_scope + sys_package on every
        // record so the provider travels with the app. ServiceNow's auto-created
        // default profile inherits the entity's scope.
        const scopeStamp: Record<string, string> = args.sysScope
          ? { sys_scope: args.sysScope, sys_package: args.sysScope }
          : {};
        // 1. oauth_entity (Application Registry record)
        const entityBody: Record<string, unknown> = {
          name: args.name,
          type: "oauth_provider",
          default_grant_type: args.grantType,
          auth_url: args.authUrl,
          token_url: args.tokenUrl,
          client_id: args.providerClientId,
          use_pkce: args.usePkce ? "true" : "false",
          code_challenge_method: args.codeChallengeMethod,
          send_client_credentials_as: args.sendCredentialsAs,
          public_client: "false",
          active: "true",
          ...scopeStamp,
        };
        if (args.redirectUrl) entityBody.redirect_url = args.redirectUrl;
        // NOTE: client_secret is intentionally NOT written here. It is a
        // password2 (encrypted) field; the Table API does not encrypt it the
        // way the SN UI password field does, so a Table-API-written secret is
        // stored malformed and the provider rejects the token exchange with
        // 401 invalid_client (verified against Webex 2026-06-08). The secret
        // must be entered once in the SN UI — see nextSteps.
        const entityResp = await snApi(
          tablePath("oauth_entity"),
          context.globalArgs,
          { method: "POST", body: entityBody },
        ) as { result: Record<string, unknown> };
        const entitySysId = entityResp.result.sys_id as string;

        // 2. Use the default oauth_entity_profile that ServiceNow AUTO-CREATES
        //    on entity insert. Do NOT create one — a second profile is rejected
        //    by the platform "Validate OAuth entity profile" business rule.
        //    Poll briefly in case the auto-creation is not yet visible.
        let profileSysId = "";
        for (let attempt = 0; attempt < 5 && !profileSysId; attempt++) {
          const profQuery = await snApi(
            tablePath("oauth_entity_profile"),
            context.globalArgs,
            {
              params: {
                sysparm_query: `oauth_entity=${entitySysId}^default=true`,
                sysparm_fields: "sys_id",
                sysparm_limit: "1",
              },
            },
          ) as { result: Array<{ sys_id: string }> };
          if (profQuery.result.length > 0) {
            profileSysId = profQuery.result[0].sys_id;
          } else {
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
        }
        if (!profileSysId) {
          throw new Error(
            `No default oauth_entity_profile was auto-created for entity ${entitySysId} ("${args.name}") — cannot attach scopes.`,
          );
        }

        // 3 + 4. scope records + profile↔scope m2m links
        const scopes: Array<{ name: string; sysId: string }> = [];
        for (const scope of args.scopes) {
          const scopeResp = await snApi(
            tablePath("oauth_entity_scope"),
            context.globalArgs,
            {
              method: "POST",
              // Both fields are required: `name` is the display label, while
              // `oauth_entity_scope` is the value ServiceNow actually sends in
              // the authorize/token request. Setting only `name` leaves the
              // scope empty on the wire → the provider rejects with
              // invalid_scope. (Verified against Webex 2026-06-02.)
              body: {
                name: scope,
                oauth_entity_scope: scope,
                oauth_entity: entitySysId,
                ...scopeStamp,
              },
            },
          ) as { result: Record<string, unknown> };
          const scopeSysId = scopeResp.result.sys_id as string;
          await snApi(
            tablePath("oauth_entity_profile_scope"),
            context.globalArgs,
            {
              method: "POST",
              body: {
                oauth_entity_profile: profileSysId,
                oauth_entity_scope: scopeSysId,
                ...scopeStamp,
              },
            },
          );
          scopes.push({ name: scope, sysId: scopeSysId });
        }

        // 5. (optional) shared Connection & Credential Alias that per-account
        //    connections attach to. multiple_connections=true lets one alias
        //    hold N connections (one per tenant/org), each with its own token
        //    set — the multi-tenant pattern. Per-account credential+connection
        //    records are created later by addOAuthAccount.
        let aliasSysId: string | undefined;
        if (args.connectionAliasName) {
          const aliasResp = await snApi(
            tablePath("sys_alias"),
            context.globalArgs,
            {
              method: "POST",
              body: {
                name: args.connectionAliasName,
                id: args.connectionAliasName,
                type: "connection",
                connection_type: "http_connection",
                multiple_connections: "true",
                ...scopeStamp,
              },
            },
          ) as { result: Record<string, unknown> };
          aliasSysId = aliasResp.result.sys_id as string;
        }

        context.logger.info(
          "Stood up OAuth provider {name}: entity={entity}, profile={profile}, {count} scope(s) linked{alias}",
          {
            name: args.name,
            entity: entitySysId,
            profile: profileSysId,
            count: scopes.length,
            alias: aliasSysId ? `, alias=${aliasSysId}` : "",
          },
        );

        const secretSet = false;
        const nextSteps = [
          `Enter the client_secret on the '${args.name}' Application Registry record (System OAuth > Application Registry), in the Client Secret password field — it cannot be set via the Table API (password2 fields are not encrypted correctly there → 401 invalid_client at token exchange).`,
          ...(aliasSysId
            ? [
              `Add one account per tenant/org with addOAuthAccount (profileSysId=${profileSysId}, connectionAliasSysId=${aliasSysId}). Each account gets its own credential + connection + one-time Get OAuth Token consent.`,
            ]
            : [
              `Create a Connection & Credential Alias with an OAuth 2.0 Credential referencing the '${args.name} default_profile' profile, and a Connection record pointing at the provider host (or re-run with connectionAliasName set, then use addOAuthAccount).`,
            ]),
          `For each account, click 'Get OAuth Token' on its Connection and complete the browser consent to mint and store the tokens.`,
        ];

        const result = {
          instanceUrl: context.globalArgs.instanceUrl,
          name: args.name,
          entitySysId,
          profileSysId,
          aliasSysId,
          sysScope: args.sysScope ?? "global",
          redirectUrl: args.redirectUrl,
          scopes,
          secretSet,
          nextSteps,
          capturedAt: new Date().toISOString(),
        };
        const dataHandle = await context.writeResource(
          "oauth-provider",
          sanitizeName(`oauth-provider-${args.name}`),
          result,
        );
        return { dataHandles: [dataHandle] };
      },
    },

    addOAuthAccount: {
      description:
        "Per-account step for an interactive (authorization_code) OAuth provider: creates an OAuth 2.0 Credential bound to the provider's default profile, an HTTP Connection bound to a shared Connection & Credential Alias, and (optionally) an operational-registry row that references the connection. One call per account/tenant/org; many accounts share one alias (multiple_connections=true) and one oauth_entity, each holding its own token set — the multi-tenant pattern. The only remaining step is a one-time interactive 'Get OAuth Token' browser consent per account (auth-code grant cannot be completed via API); the consent URL is returned in nextSteps. Pair with setupOAuthProvider (which returns profileSysId + aliasSysId).",
      arguments: z.object({
        accountName: z.string().min(1).describe(
          "Human label for this account/org (e.g. 'Contoso Webex Org'). Used to name the credential and connection records.",
        ),
        oauthEntityProfileSysId: z.string().min(1).describe(
          "sys_id of the provider's default oauth_entity_profile (setupOAuthProvider returns this as profileSysId).",
        ),
        connectionAliasSysId: z.string().optional().describe(
          "sys_id of an EXISTING Connection & Credential Alias to attach this connection to. Omit (recommended) to mint a dedicated PER-ORG alias — that keeps sn_cc.ConnectionInfoProvider.getConnectionInfo(alias) deterministic per tenant (one connection per alias). Pass a shared alias only for the multiple_connections pattern.",
        ),
        connectionAliasName: z.string().optional().describe(
          "Name/id for the per-org alias when one is minted (connectionAliasSysId omitted). Defaults to '<accountName>-alias' sanitized.",
        ),
        connectionUrl: z.string().min(1).describe(
          "Base URL the connection targets, e.g. https://webexapis.com. host + protocol are derived from it.",
        ),
        sysScope: z.string().optional().describe(
          "Scoped application sys_id to create the credential, connection, and registry row IN. Omit for global.",
        ),
        registryTable: z.string().optional().describe(
          "Optional operational-registry table to insert a tracking row into (e.g. x_asei_cisco_hub_webex_org). The created connection's sys_id is injected automatically.",
        ),
        registryFields: z.record(z.string(), z.unknown()).optional().describe(
          "Field map for the registry row (e.g. {name: 'Contoso', webex_org_id: '...'}) . Combined with the auto-injected connection reference. Pass via --stdin or a workflow step (nested objects don't survive --input key=value).",
        ),
        registryConnectionField: z.string().optional().default("connection")
          .describe(
            "Field on the registry row that should reference the created http_connection (default 'connection').",
          ),
      }),
      execute: async (
        args: {
          accountName: string;
          oauthEntityProfileSysId: string;
          connectionAliasSysId?: string;
          connectionAliasName?: string;
          connectionUrl: string;
          sysScope?: string;
          registryTable?: string;
          registryFields?: Record<string, unknown>;
          registryConnectionField: string;
        },
        context: SnContext,
      ) => {
        const scopeStamp: Record<string, string> = args.sysScope
          ? { sys_scope: args.sysScope, sys_package: args.sysScope }
          : {};
        const parsedUrl = new URL(args.connectionUrl);
        const host = parsedUrl.host;
        const protocol = parsedUrl.protocol.replace(/:$/, "");

        // 0. Resolve the alias: use an existing one if given, else mint a
        //    PER-ORG alias (single connection) so getConnectionInfo(alias) is
        //    deterministic per tenant in the multi-tenant model.
        let aliasSysId = args.connectionAliasSysId;
        let aliasMinted = false;
        if (!aliasSysId) {
          const aliasName = args.connectionAliasName ||
            (sanitizeName(args.accountName) + "-alias");
          const aliasResp = await snApi(
            tablePath("sys_alias"),
            context.globalArgs,
            {
              method: "POST",
              body: {
                name: aliasName,
                id: aliasName,
                type: "connection",
                connection_type: "http_connection",
                multiple_connections: "false",
                ...scopeStamp,
              },
            },
          ) as { result: Record<string, unknown> };
          aliasSysId = aliasResp.result.sys_id as string;
          aliasMinted = true;
        }

        // 1. OAuth 2.0 Credential bound to the provider's default profile.
        //    POST to the oauth_2_0_credentials child table so sys_class_name +
        //    classification/type land as oauth_2_0 (posting to the
        //    discovery_credentials base would not set the subclass).
        const credResp = await snApi(
          tablePath("oauth_2_0_credentials"),
          context.globalArgs,
          {
            method: "POST",
            body: {
              name: `${args.accountName} credential`,
              oauth_entity_profile: args.oauthEntityProfileSysId,
              type: "oauth_2_0",
              applies_to: "all",
              active: "true",
              ...scopeStamp,
            },
          },
        ) as { result: Record<string, unknown> };
        const credentialSysId = credResp.result.sys_id as string;

        // 2. HTTP Connection bound to the shared alias + this credential.
        const connResp = await snApi(
          tablePath("http_connection"),
          context.globalArgs,
          {
            method: "POST",
            body: {
              name: `${args.accountName} connection`,
              connection_alias: aliasSysId,
              credential: credentialSysId,
              connection_url: args.connectionUrl,
              host,
              protocol,
              mid_selection: "auto_select",
              order: "100",
              active: "true",
              ...scopeStamp,
            },
          },
        ) as { result: Record<string, unknown> };
        const connectionSysId = connResp.result.sys_id as string;

        // 3. (optional) operational-registry row referencing the connection.
        let registryRowSysId: string | undefined;
        if (args.registryTable) {
          const rowResp = await snApi(
            tablePath(args.registryTable),
            context.globalArgs,
            {
              method: "POST",
              body: {
                ...(args.registryFields ?? {}),
                [args.registryConnectionField]: connectionSysId,
                ...scopeStamp,
              },
            },
          ) as { result: Record<string, unknown> };
          registryRowSysId = rowResp.result.sys_id as string;
        }

        const instanceUrl = context.globalArgs.instanceUrl.replace(/\/+$/, "");
        const getTokenUrl =
          `${instanceUrl}/http_connection.do?sys_id=${connectionSysId}`;

        context.logger.info(
          "Added OAuth account {account}: credential={cred}, connection={conn}{row}",
          {
            account: args.accountName,
            cred: credentialSysId,
            conn: connectionSysId,
            row: registryRowSysId ? `, registryRow=${registryRowSysId}` : "",
          },
        );

        const nextSteps = [
          `Open the '${args.accountName} connection' record (${getTokenUrl}) and click 'Get OAuth Token' (Related Links). Complete the browser consent as the account's admin to mint and store the token set.`,
          `Tokens land in oauth_credential (peer = the provider entity). Verify with tableQuery on oauth_credential filtered to this credential.`,
        ];

        const result = {
          instanceUrl: context.globalArgs.instanceUrl,
          accountName: args.accountName,
          credentialSysId,
          connectionSysId,
          aliasSysId,
          aliasMinted,
          registryRowSysId,
          getTokenUrl,
          nextSteps,
          capturedAt: new Date().toISOString(),
        };
        const dataHandle = await context.writeResource(
          "oauth-account",
          sanitizeName(`oauth-account-${args.accountName}`),
          result,
        );
        return { dataHandles: [dataHandle] };
      },
    },
  },
};
