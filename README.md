# mpp-discovery-mcp

Read-only Cloudflare Worker MCP server for the MPP service discovery catalog.

Deployed endpoint:

```text
https://mpp-discovery-mcp.tempo-dev.workers.dev/mcp
```

Server card:

```text
https://mpp-discovery-mcp.tempo-dev.workers.dev/.well-known/mcp.json
```

## Data source

The Worker reads `GET https://mpp.dev/api/services`, which returns:

```ts
{ version: number, services: Service[] }
```

Offers are read from `service.endpoints[].payment`. The Worker does not fetch
per-service `/openapi.json` files while refreshing the catalog.

Discovery is advisory. The runtime `402 Challenge` from the target paid API is
authoritative.

## Refresh model

- KV binding: `MPP_CATALOG_CACHE`
- Cache key: `mpp:services:v1`
- Hourly cron: `0 * * * *`
- Requests use fresh KV data when it is less than one hour old.
- If KV data is stale, requests serve the last-good cached catalog and refresh
  in the background.
- If `mpp.dev` is unreachable during cron refresh, the Worker logs the failure
  and keeps the last-good KV value.
- There is no public write, sync, registration, payment, or auth path.

## Tools

All tool responses include `structuredContent`, an `outputSchema`, and a text
summary. Discovery is advisory; the runtime `402 Challenge` from the target
paid API remains authoritative.

- `list_services(limit?, offset?)` -> paginated `id`, `name`, `url`,
  `categories`, `integration`, `status`, `description`; default `limit` is 50
  and max is 200
- `search_services(query?, category?, method?, integration?, status?, limit?,
  offset?)` -> paginated substring search over name, description, and tags plus
  exact filters; `category`, `integration`, and `status` are validated against
  the registry enums and invalid values return an MCP tool error
- `get_service(id_or_name)` -> full `Service`
- `get_offers(service, route?)` -> endpoint payment offers from
  `endpoints[].payment`
- `get_openapi(service, raw?)` -> validated OpenAPI data from
  `service.docs.openapi`, `${service.url}/openapi.json`,
  `service.docs.apiReference`, or a registry-derived endpoint view. Fetched
  candidates must use HTTPS, return HTTP 200 JSON, and be OpenAPI-shaped
  (`openapi` string or `paths` object); HTML, non-OpenAPI JSON, redirects beyond
  3 hops, oversized fetches, and network failures fall back gracefully. The
  default response is a summary with `openapiVersion`, `info.title/version`,
  `x-service-info`, and `paths[]` entries containing `method`, `path`,
  `summary`, and payment offers from `x-payment-info`. Set `raw: true` to
  request the full fetched document when it is under the 256 KiB raw response
  cap; larger raw requests return the summary plus a note and source URL.

## MCP client config

For clients that accept a remote streamable HTTP MCP URL:

```json
{
  "mcpServers": {
    "mpp-discovery": {
      "url": "https://mpp-discovery-mcp.tempo-dev.workers.dev/mcp"
    }
  }
}
```

For clients that need a local stdio bridge:

```json
{
  "mcpServers": {
    "mpp-discovery": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://mpp-discovery-mcp.tempo-dev.workers.dev/mcp"
      ]
    }
  }
}
```

## Development

```bash
pnpm install
pnpm gen:types
pnpm test
pnpm check:types
pnpm dev
```

Deploys are pinned to the Tempo Development Cloudflare account:

```text
Tempo Development Resources / 0a39052b0a32ba8c8444345fe21b7595
```

Deploy:

```bash
pnpm deploy
```
