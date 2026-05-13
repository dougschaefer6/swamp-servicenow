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
 * @dougschaefer/servicenow-instance — General-purpose ServiceNow integration model.
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
  version: "2026.05.05.3",
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
  },
};
