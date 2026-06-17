import { getCatalog } from "./cache.js"
import {
	findService,
	listServiceSummaries,
	offersForService,
	registryOpenApiView,
	searchServices,
	type SearchServicesArgs,
} from "./discovery.js"
import { CATEGORIES, INTEGRATIONS, STATUSES, type Service } from "./types.js"

const PROTOCOL_VERSION = "2025-06-18"
const SERVER_VERSION = "1.0.0"
const ADVISORY =
	"Discovery is advisory; the runtime 402 Challenge is authoritative."

const INITIALIZE_INSTRUCTIONS = [
	"Use this read-only MCP server to discover MPP paid API services and payment terms from https://mpp.dev/api/services.",
	"Call list_services for a catalog overview, search_services to filter by query/category/payment method/integration/status, get_service for a full service record, get_offers for endpoint payment offers, and get_openapi for a service OpenAPI document or registry-derived endpoint view.",
	ADVISORY,
	"This server does not register services, execute payments, authorize requests, or replace runtime 402 Challenge validation.",
].join(" ")

type JsonRpcId = string | number | null

type JsonRpcRequest = {
	jsonrpc?: string
	id?: JsonRpcId
	method?: string
	params?: unknown
}

type ToolCallParams = {
	name?: unknown
	arguments?: unknown
}

type JsonRpcResponsePayload =
	| { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
	| { jsonrpc: "2.0"; id: JsonRpcId; error: { code: number; message: string } }

export async function handleMcp(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
): Promise<Response> {
	let payload: unknown
	try {
		payload = await request.json()
	} catch {
		return jsonResponse(jsonRpcError(null, -32700, "Parse error"))
	}

	if (Array.isArray(payload)) {
		const responses: JsonRpcResponsePayload[] = []
		for (const item of payload) {
			const response = await handleMessage(asRequest(item), env, ctx)
			if (response) responses.push(response)
		}
		if (responses.length === 0) return emptyAcceptedResponse()
		return jsonResponse(responses)
	}

	const response = await handleMessage(asRequest(payload), env, ctx)
	if (!response) return emptyAcceptedResponse()
	return jsonResponse(response)
}

export function serverCard(origin: string) {
	return {
		$schema: "https://static.modelcontextprotocol.io/schemas/mcp-server-card/v1.json",
		version: "1.0",
		protocolVersion: PROTOCOL_VERSION,
		serverInfo: serverInfo(),
		description:
			"Read-only MCP server exposing the MPP service discovery catalog and payment terms as advisory MCP tools.",
		documentationUrl: "https://mpp.dev/",
		iconUrl: "https://mpp.dev/favicon.svg",
		transport: {
			type: "streamable-http",
			endpoint: `${origin}/mcp`,
		},
		capabilities: {
			tools: {},
		},
		authentication: {
			required: false,
			schemes: [],
		},
		instructions: INITIALIZE_INSTRUCTIONS,
		tools: "dynamic",
	}
}

export function jsonHeaders(extra?: HeadersInit): Headers {
	const headers = new Headers(extra)
	headers.set("content-type", "application/json")
	headers.set("access-control-allow-origin", "*")
	headers.set("access-control-allow-methods", "GET,POST,OPTIONS")
	headers.set(
		"access-control-allow-headers",
		"content-type,mcp-protocol-version",
	)
	headers.set("mcp-protocol-version", PROTOCOL_VERSION)
	return headers
}

export function optionsResponse(): Response {
	return new Response(null, { status: 204, headers: jsonHeaders() })
}

async function handleMessage(
	request: JsonRpcRequest | undefined,
	env: Env,
	ctx: ExecutionContext,
): Promise<JsonRpcResponsePayload | undefined> {
	if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
		return jsonRpcError(request?.id ?? null, -32600, "Invalid Request")
	}

	switch (request.method) {
		case "initialize":
			return jsonRpcResult(request.id ?? null, initializeResult(request.params))
		case "notifications/initialized":
			return undefined
		case "ping":
			return jsonRpcResult(request.id ?? null, {})
		case "tools/list":
			return jsonRpcResult(request.id ?? null, { tools: toolSchemas() })
		case "tools/call":
			return jsonRpcResult(
				request.id ?? null,
				await handleToolCall(toolCallParams(request.params), env, ctx),
			)
		case "resources/list":
			return jsonRpcResult(request.id ?? null, { resources: [] })
		case "resources/templates/list":
			return jsonRpcResult(request.id ?? null, { resourceTemplates: [] })
		case "prompts/list":
			return jsonRpcResult(request.id ?? null, { prompts: [] })
		default:
			return jsonRpcError(
				request.id ?? null,
				-32601,
				`Method not found: ${request.method}`,
			)
	}
}

async function handleToolCall(
	params: ToolCallParams,
	env: Env,
	ctx: ExecutionContext,
) {
	const name = typeof params.name === "string" ? params.name : ""
	const args = objectArgs(params.arguments)

	try {
		const catalog = await getCatalog(env, ctx)
		const meta = {
			advisory: ADVISORY,
			catalogVersion: catalog.version,
			cacheStatus: catalog.cacheStatus,
			fetchedAt: catalog.fetchedAt,
			sourceUrl: catalog.sourceUrl,
		}

		if (name === "list_services") {
			const services = listServiceSummaries(catalog.services)
			return toolResult(
				{ ...meta, count: services.length, services },
				`Returned ${services.length} MPP services. ${ADVISORY}`,
			)
		}

		if (name === "search_services") {
			const filters = searchArgs(args)
			const services = searchServices(catalog.services, filters)
			return toolResult(
				{ ...meta, filters, count: services.length, services },
				`Matched ${services.length} MPP services. ${ADVISORY}`,
			)
		}

		if (name === "get_service") {
			const service = requireService(
				catalog.services,
				requiredString(args, "id_or_name"),
			)
			return toolResult(
				{ ...meta, service },
				`Returned service ${service.id}. ${ADVISORY}`,
			)
		}

		if (name === "get_offers") {
			const service = requireService(
				catalog.services,
				requiredString(args, "service"),
			)
			const route = optionalString(args, "route")
			const offers = offersForService(service, route)
			return toolResult(
				{
					...meta,
					service: serviceRef(service),
					...(route ? { route } : {}),
					count: offers.length,
					offers,
				},
				`Returned ${offers.length} payment offers for ${service.id}. ${ADVISORY}`,
			)
		}

		if (name === "get_openapi") {
			const service = requireService(
				catalog.services,
				requiredString(args, "service"),
			)
			const openapi = await openApiFor(service)
			return toolResult(
				{ ...meta, service: serviceRef(service), openapi },
				`${openapi.source === "openapi" ? "Fetched OpenAPI" : "Returned registry endpoint view"} for ${service.id}. ${ADVISORY}`,
			)
		}

		return toolError(`Unknown tool: ${name || "(missing)"}`)
	} catch (error) {
		return toolError(errorMessage(error))
	}
}

async function openApiFor(service: Service) {
	const openapiUrl = service.docs?.openapi
	if (!openapiUrl) return registryOpenApiView(service)

	const response = await fetch(openapiUrl, {
		headers: { accept: "application/json, application/yaml, text/yaml, */*" },
		cf: { cacheTtl: 300 },
	})
	if (!response.ok) {
		throw new Error(`OpenAPI fetch failed for ${service.id}: ${response.status}`)
	}

	const contentType = response.headers.get("content-type") ?? "unknown"
	const text = await response.text()
	return {
		source: "openapi",
		openapiUrl,
		contentType,
		document: parseJsonIfPossible(text),
	}
}

function initializeResult(params: unknown) {
	const requested =
		typeof params === "object" && params !== null
			? (params as { protocolVersion?: unknown }).protocolVersion
			: undefined
	const protocolVersion =
		typeof requested === "string" && requested.length > 0
			? requested
			: PROTOCOL_VERSION

	return {
		protocolVersion:
			protocolVersion === PROTOCOL_VERSION ? PROTOCOL_VERSION : PROTOCOL_VERSION,
		capabilities: {
			tools: {},
		},
		serverInfo: serverInfo(),
		instructions: INITIALIZE_INSTRUCTIONS,
	}
}

function serverInfo() {
	return {
		name: "mpp-discovery-mcp",
		title: "MPP Discovery MCP server",
		version: SERVER_VERSION,
	}
}

function toolSchemas() {
	const advisory = ` ${ADVISORY}`
	return [
		{
			name: "list_services",
			description:
				"List MPP discovery catalog services with id, name, URL, categories, integration, status, and description." +
				advisory,
			inputSchema: {
				type: "object",
				properties: {},
				additionalProperties: false,
			},
			execution: { taskSupport: "forbidden" },
		},
		{
			name: "search_services",
			description:
				"Search MPP services by simple substring query over name, description, and tags, plus exact filters for category, payment method, integration, and status." +
				advisory,
			inputSchema: {
				type: "object",
				properties: {
					query: { type: "string", description: "Substring query." },
					category: {
						type: "string",
						enum: CATEGORIES,
						description: "Exact category filter.",
					},
					method: {
						type: "string",
						description: "Exact payment method filter, for example tempo.",
					},
					integration: {
						type: "string",
						enum: INTEGRATIONS,
						description: "Exact integration filter.",
					},
					status: {
						type: "string",
						enum: STATUSES,
						description: "Exact status filter.",
					},
				},
				additionalProperties: false,
			},
			execution: { taskSupport: "forbidden" },
		},
		{
			name: "get_service",
			description: "Get the full MPP Service record by id or name." + advisory,
			inputSchema: {
				type: "object",
				properties: {
					id_or_name: {
						type: "string",
						description: "Service id or exact service name.",
					},
				},
				required: ["id_or_name"],
				additionalProperties: false,
			},
			execution: { taskSupport: "forbidden" },
		},
		{
			name: "get_offers",
			description:
				"Return endpoint payment offers for a service, optionally filtered by route substring." +
				advisory,
			inputSchema: {
				type: "object",
				properties: {
					service: { type: "string", description: "Service id or name." },
					route: {
						type: "string",
						description: "Optional route substring such as POST /v1/messages.",
					},
				},
				required: ["service"],
				additionalProperties: false,
			},
			execution: { taskSupport: "forbidden" },
		},
		{
			name: "get_openapi",
			description:
				"Fetch service.docs.openapi live when present; otherwise return a registry-derived endpoint view." +
				advisory,
			inputSchema: {
				type: "object",
				properties: {
					service: { type: "string", description: "Service id or name." },
				},
				required: ["service"],
				additionalProperties: false,
			},
			execution: { taskSupport: "forbidden" },
		},
	] as const
}

function toolResult(structuredContent: unknown, text: string) {
	return {
		content: [{ type: "text", text }],
		structuredContent,
	}
}

function toolError(message: string) {
	return {
		content: [{ type: "text", text: message }],
		structuredContent: { success: false, error: message },
		isError: true,
	}
}

function searchArgs(args: Record<string, unknown>): SearchServicesArgs {
	return {
		...(optionalString(args, "query") ? { query: optionalString(args, "query") } : {}),
		...(enumValue(CATEGORIES, args.category) ? { category: enumValue(CATEGORIES, args.category) } : {}),
		...(optionalString(args, "method") ? { method: optionalString(args, "method") } : {}),
		...(enumValue(INTEGRATIONS, args.integration)
			? { integration: enumValue(INTEGRATIONS, args.integration) }
			: {}),
		...(enumValue(STATUSES, args.status) ? { status: enumValue(STATUSES, args.status) } : {}),
	}
}

function requireService(services: Service[], idOrName: string): Service {
	const service = findService(services, idOrName)
	if (!service) throw new Error(`Unknown service: ${idOrName}`)
	return service
}

function serviceRef(service: Service) {
	return {
		id: service.id,
		name: service.name,
		url: service.url,
		...(service.serviceUrl ? { serviceUrl: service.serviceUrl } : {}),
	}
}

function requiredString(args: Record<string, unknown>, key: string): string {
	const value = optionalString(args, key)
	if (!value) throw new Error(`${key} must be a non-empty string`)
	return value
}

function optionalString(
	args: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = args[key]
	if (typeof value !== "string") return undefined
	const trimmed = value.trim()
	return trimmed || undefined
}

function enumValue<const T extends readonly string[]>(
	values: T,
	value: unknown,
): T[number] | undefined {
	return typeof value === "string" && values.includes(value)
		? (value as T[number])
		: undefined
}

function objectArgs(value: unknown): Record<string, unknown> {
	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		return value as Record<string, unknown>
	}
	return {}
}

function toolCallParams(value: unknown): ToolCallParams {
	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		return value as ToolCallParams
	}
	return {}
}

function parseJsonIfPossible(text: string): unknown {
	try {
		return JSON.parse(text)
	} catch {
		return text
	}
}

function asRequest(value: unknown): JsonRpcRequest | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined
	}
	return value as JsonRpcRequest
}

function jsonRpcResult(id: JsonRpcId, result: unknown): JsonRpcResponsePayload {
	return { jsonrpc: "2.0", id, result }
}

function jsonRpcError(
	id: JsonRpcId,
	code: number,
	message: string,
): JsonRpcResponsePayload {
	return { jsonrpc: "2.0", id, error: { code, message } }
}

function jsonResponse(payload: unknown): Response {
	return new Response(JSON.stringify(payload), { headers: jsonHeaders() })
}

function emptyAcceptedResponse(): Response {
	return new Response(null, { status: 202, headers: jsonHeaders() })
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
