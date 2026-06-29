# @dougschaefer/servicenow

Swamp extension for working with a ServiceNow instance over its REST API. Authenticates with OAuth 2.0 client_credentials, caches the access token within the executing process, and provides typed methods covering generic Table API CRUD, the Aggregate API for analysis, and a passthrough REST call for everything else.

Designed as the foundation for ServiceNow spoke development, administrative tasks, and ad-hoc data operations driven from swamp workflows.

## Models

| Type | Description |
|---|---|
| `@dougschaefer/servicenow-instance` | Instance-level operations: identity, table CRUD, aggregates, generic REST, and OAuth provider provisioning |

## Installation

```bash
swamp extension pull @dougschaefer/servicenow
```

## Authentication

The model uses OAuth 2.0 **client_credentials** grant against `{instanceUrl}/oauth_token.do`. On the ServiceNow side this requires:

1. The platform property `glide.oauth.inbound.client.credential.grant_type.enabled` set to **true**. This property is not present by default — create it as a `true | false` system property if it does not exist.
2. An OAuth Application Registry record (or a "Machine Identity" / inbound integration in newer releases) configured for client_credentials grant.
3. The Application Registry must be bound to a user record. The token impersonates that user, inheriting their roles and ACLs. For administrative work, bind to System Administrator (`admin`).

The standard scope value is `useraccount`.

## Configuration

Vault-backed credentials (recommended):

```yaml
type: "@dougschaefer/servicenow-instance"
name: my-instance
globalArguments:
  instanceUrl: ${{ vault.get(servicenow, instance-url) }}
  clientId: ${{ vault.get(servicenow, client-id) }}
  clientSecret: ${{ vault.get(servicenow, client-secret) }}
  scope: useraccount
attributes: {}
```

## Methods

### `lookup`

Verifies credentials, captures instance metadata (release, build, scope prefix), and identifies the user the token impersonates. Run first to confirm connectivity. Writes an `instance-info` resource.

```bash
swamp model method run my-instance lookup --json
```

### `tableQuery`

Generic Table API list with `sysparm_query` filter. Returns each row as a `record` resource.

```bash
swamp model method run my-instance tableQuery \
  --arg table=incident \
  --arg query="active=true^state=1" \
  --arg fields="number,short_description,priority,assigned_to" \
  --arg limit=50 --json
```

### `tableGet`

Single record by sys_id.

```bash
swamp model method run my-instance tableGet \
  --arg table=sys_user \
  --arg sysId=6816f79cc0a8016401c5a33be04be441 --json
```

### `tableCreate` / `tableUpdate` / `tableDelete`

Insert, update (PATCH semantics — only provided fields change), and delete by sys_id.

```bash
swamp model method run my-instance tableCreate \
  --arg table=incident \
  --arg fields='{"short_description":"Test from swamp","urgency":"3"}' --json
```

### `tableAggregate`

Aggregate API for count, sum, avg, min, max, and group_by — use this for data analysis without pulling full record sets.

```bash
swamp model method run my-instance tableAggregate \
  --arg table=incident \
  --arg query="active=true" \
  --arg groupBy=priority --json
```

### `restCall`

Passthrough REST call for endpoints outside the Table API (Scripted REST APIs, Import API, application-specific endpoints).

```bash
swamp model method run my-instance restCall \
  --arg path=/api/sn_chg_rest/change \
  --arg method=GET --json
```

### `setupOAuthProvider`

Fan-out helper that stands up a third-party OAuth 2.0 provider for an integration spoke in a single execution: creates the OAuth Application Registry record (`oauth_entity`), its default profile, all scope records, and the profile↔scope links. Use this to provision the provider side of a spoke before connecting accounts.

```bash
swamp model method run my-instance setupOAuthProvider \
  --arg name="My Spoke Provider" \
  --arg clientId=... --arg clientSecret=... --json
```

### `addOAuthAccount`

Per-account step for an interactive (authorization_code) provider: creates an OAuth 2.0 Credential bound to the provider's default profile, an HTTP Connection bound to a shared Connection & Credential Alias, and optionally an operational-registry row referencing the connection. Pass `connectionAliasSysId` to reuse an existing alias, or `connectionAliasName` to mint one.

```bash
swamp model method run my-instance addOAuthAccount \
  --arg providerSysId=... \
  --arg connectionAliasName=my-spoke-alias --json
```

## Token Caching

The OAuth access token is cached within the executing process. A single `swamp model method run` invocation makes one OAuth token request and reuses the token for every subsequent HTTP call. When swamp is invoked again, a fresh token is requested. ServiceNow access tokens have a 30-minute lifetime by default, so this acquisition cost (~80–150 ms per invocation) is paid at most once per command.

If cross-invocation caching becomes important, the cached token can be persisted to a swamp data artifact in a future revision.

## Permissions

The token inherits the ACLs of the user the OAuth client is bound to. For development against a vendor instance, binding to System Administrator gives full access. For production deployments, scope the bound user's roles to the minimum needed (e.g., `personalize_choices`, `app_engine_admin`, specific table roles).

## License

MIT — see LICENSE.txt.
