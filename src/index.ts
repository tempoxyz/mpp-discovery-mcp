import { refreshCatalog } from "./cache.js"
import {
	handleMcp,
	jsonHeaders,
	optionsResponse,
	serverCard,
} from "./mcp.js"

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		const url = new URL(request.url)

		if (request.method === "OPTIONS") return optionsResponse()

		if (url.pathname === "/.well-known/mcp.json" && request.method === "GET") {
			return Response.json(serverCard(url.origin), { headers: jsonHeaders() })
		}

		if ((url.pathname === "/mcp" || url.pathname === "/") && request.method === "POST") {
			return handleMcp(request, env, ctx)
		}

		if (url.pathname === "/" && request.method === "GET") {
			return Response.json(
				{
					name: "mpp-discovery-mcp",
					mcp: `${url.origin}/mcp`,
					serverCard: `${url.origin}/.well-known/mcp.json`,
					description:
						"Read-only MCP server for the MPP service discovery catalog.",
				},
				{ headers: jsonHeaders() },
			)
		}

		if (url.pathname === "/mcp" && request.method === "GET") {
			return Response.json(serverCard(url.origin), { headers: jsonHeaders() })
		}

		return Response.json(
			{ error: "not found" },
			{ status: 404, headers: jsonHeaders() },
		)
	},

	async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
		const startedAt = Date.now()
		ctx.waitUntil(
			refreshCatalog(env)
				.then((catalog) => {
					console.log(
						JSON.stringify({
							message: "catalog.refresh_complete",
							cron: event.cron,
							scheduledTime: new Date(event.scheduledTime).toISOString(),
							durationMs: Date.now() - startedAt,
							version: catalog.version,
							services: catalog.services.length,
							fetchedAt: catalog.fetchedAt,
						}),
					)
				})
				.catch((error) => {
					console.error(
						JSON.stringify({
							message: "catalog.refresh_failed",
							cron: event.cron,
							scheduledTime: new Date(event.scheduledTime).toISOString(),
							durationMs: Date.now() - startedAt,
							error: error instanceof Error ? error.message : String(error),
						}),
					)
				}),
		)
	},
} satisfies ExportedHandler<Env>
