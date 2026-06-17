import { afterEach, describe, expect, it, vi } from "vitest"
import { handleMcp, serverCard } from "./mcp.js"
import type { CachedCatalog } from "./cache.js"
import type { Service } from "./types.js"

const services: Service[] = [
	{
		id: "agentmail",
		name: "AgentMail",
		url: "https://mpp.api.agentmail.to",
		description: "Email inboxes for AI agents.",
		categories: ["ai", "social"],
		integration: "first-party",
		tags: ["email", "fax"],
		status: "active",
		methods: { tempo: { intents: ["charge"] } },
		endpoints: [
			{ method: "GET", path: "/v0/inboxes", payment: null },
			{
				method: "POST",
				path: "/v0/inboxes",
				description: "Create inbox",
				payment: {
					intent: "charge",
					method: "tempo",
					amount: "2000000",
				},
			},
		],
	},
	{
		id: "anthropic",
		name: "Anthropic",
		url: "https://api.anthropic.com",
		description: "Claude chat completions.",
		categories: ["ai"],
		integration: "third-party",
		tags: ["llm", "claude"],
		status: "active",
		docs: { openapi: "https://example.com/openapi.json" },
		methods: { tempo: { intents: ["session"] } },
		endpoints: [
			{
				method: "POST",
				path: "/v1/messages",
				payment: {
					intent: "session",
					method: "tempo",
					dynamic: true,
				},
			},
		],
	},
	{
		id: "legacy",
		name: "Legacy",
		url: "https://legacy.example.com",
		categories: ["data"],
		integration: "third-party",
		tags: ["archive"],
		status: "deprecated",
		methods: {},
		endpoints: [],
	},
]

describe("mcp handler", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("advertises outputSchema for every tool", async () => {
		const body = await mcp("tools/list", {}, envWithCatalog())
		const tools = body.result.tools ?? []
		expect(tools).toHaveLength(5)
		for (const tool of tools) {
			expect(tool.outputSchema).toEqual(
				expect.objectContaining({ type: "object" }),
			)
		}
	})

	it("rejects invalid enum filters instead of silently dropping them", async () => {
		for (const args of [
			{ category: "boguscat" },
			{ integration: "bogusint" },
			{ status: "bogusstatus" },
		]) {
			const body = await callTool("search_services", args)
			expect(body.result.isError).toBe(true)
			expect(body.result.structuredContent).toEqual(
				expect.objectContaining({
					success: false,
					error: expect.stringContaining("Allowed values:"),
				}),
			)
		}
	})

	it("paginates list and search responses and echoes applied filters", async () => {
		const listBody = await callTool("list_services", { limit: 2, offset: 1 })
		expect(listBody.result.structuredContent).toEqual(
			expect.objectContaining({
				count: 3,
				total: 3,
				returned: 2,
				offset: 1,
				limit: 2,
			}),
		)
		expect(listBody.result.structuredContent.services.map(serviceId)).toEqual([
			"anthropic",
			"legacy",
		])

		const searchBody = await callTool("search_services", {
			category: "ai",
			method: "tempo",
			limit: 1,
		})
		expect(searchBody.result.structuredContent).toEqual(
			expect.objectContaining({
				appliedFilters: { category: "ai", method: "tempo" },
				count: 2,
				total: 2,
				returned: 1,
			}),
		)
		expect(searchBody.result.structuredContent.services.map(serviceId)).toEqual([
			"agentmail",
		])
	})

	it("resolves get_openapi through service.url/openapi.json when docs.openapi is absent", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				expect(String(input)).toBe("https://mpp.api.agentmail.to/openapi.json")
				return Response.json({ openapi: "3.1.0", info: { title: "AgentMail" } })
			}),
		)

		const body = await callTool("get_openapi", { service: "agentmail" })
		expect(body.result.structuredContent).toEqual(
			expect.objectContaining({
				source: "well-known",
				openapi: expect.objectContaining({
					source: "well-known",
					url: "https://mpp.api.agentmail.to/openapi.json",
					document: expect.objectContaining({ openapi: "3.1.0" }),
				}),
			}),
		)
	})

	it("falls back to the registry view when OpenAPI fetch candidates fail", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("missing", { status: 404 })),
		)

		const body = await callTool("get_openapi", { service: "agentmail" })
		expect(body.result.structuredContent).toEqual(
			expect.objectContaining({
				source: "registry",
				openapi: expect.objectContaining({
					source: "registry",
					endpoints: expect.arrayContaining([
						expect.objectContaining({ path: "/v0/inboxes" }),
					]),
				}),
			}),
		)
	})

	it("uses the advanced discovery documentation URL in the server card", () => {
		expect(serverCard("https://example.com")).toEqual(
			expect.objectContaining({
				documentationUrl: "https://mpp.dev/advanced/discovery",
			}),
		)
	})
})

async function callTool(name: string, args: Record<string, unknown>) {
	return mcp("tools/call", { name, arguments: args }, envWithCatalog())
}

async function mcp(
	method: string,
	params: Record<string, unknown>,
	env: Env,
) {
	const response = await handleMcp(
		new Request("https://example.com/mcp", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
		}),
		env,
		testContext(),
	)
	return response.json() as Promise<{
		result: {
			tools?: Array<{ outputSchema?: unknown }>
			isError?: boolean
			structuredContent: {
				count?: number
				total?: number
				returned?: number
				offset?: number
				limit?: number
				source?: string
				services: Array<{ id: string }>
				openapi?: unknown
			}
		}
	}>
}

function envWithCatalog(): Env {
	const catalog: CachedCatalog = {
		version: 1,
		services,
		fetchedAt: new Date().toISOString(),
		sourceUrl: "https://mpp.dev/api/services",
	}
	return {
		MPP_SERVICES_URL: "https://mpp.dev/api/services",
		MPP_CATALOG_CACHE: {
			async get() {
				return catalog
			},
			async put() {},
		} as unknown as KVNamespace,
	} as Env
}

function testContext(): ExecutionContext {
	return {
		waitUntil() {},
		passThroughOnException() {},
		props: {},
	} as unknown as ExecutionContext
}

function serviceId(service: { id: string }): string {
	return service.id
}
