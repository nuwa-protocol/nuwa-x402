import { facilitator } from "@coinbase/x402";
import z from "zod";
import { getOrCreateSellerAccount } from "@/lib/accounts";
import { env } from "@/lib/env";
import { createPaidMcpHandler } from "../../service/x402-mcp-server";

const sellerAccount = await getOrCreateSellerAccount();

const handler = createPaidMcpHandler(
	(server) => {
		server.paidTool(
			"get_random_number",
			"Get a random number between two numbers",
			{ price: 0.001 },
			{
				min: z.number().int(),
				max: z.number().int(),
			},
			{},
			async (args) => {
				const randomNumber =
					Math.floor(Math.random() * (args.max - args.min + 1)) + args.min;
				return {
					content: [{ type: "text", text: randomNumber.toString() }],
				};
			},
		);
		server.paidTool(
			"add",
			"Add two numbers",
			{ price: 0.001 },
			{
				a: z.number().int(),
				b: z.number().int(),
			},
			{},
			async (args) => {
				const result = args.a + args.b;
				return {
					content: [{ type: "text", text: result.toString() }],
				};
			},
		);
		server.tool(
			"hello-remote",
			"Receive a greeting",
			{
				name: z.string(),
			},
			async (args) => {
				return { content: [{ type: "text", text: `Hello ${args.name}` }] };
			},
		);
	},
	{
		serverInfo: {
			name: "test-mcp",
			version: "0.0.1",
		},
	},
	{
		recipient: sellerAccount.address,
		facilitator,
		network: env.NETWORK,
	},
);

const localhostPrefixes = ["http://localhost", "http://127.0.0.1"];

const allowedOrigins = new Set(
	[env.URL?.replace(/\/$/, ""), ...localhostPrefixes].filter(Boolean),
);

function resolveOrigin(request: Request) {
	const incomingOrigin = request.headers.get("origin")?.replace(/\/$/, "");
	if (!incomingOrigin) {
		return env.URL;
	}

	// Allow localhost during development without requiring extra env config.
	if (localhostPrefixes.some((prefix) => incomingOrigin.startsWith(prefix))) {
		return incomingOrigin;
	}

	return allowedOrigins.has(incomingOrigin) ? incomingOrigin : undefined;
}

function applyCorsHeaders(request: Request, response: Response) {
	const origin = resolveOrigin(request);
	if (!origin) {
		return response;
	}

	response.headers.set("Access-Control-Allow-Origin", origin);
	response.headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");

	const requestHeaders =
		request.headers.get("access-control-request-headers") ??
		"Content-Type,Authorization,X-Requested-With";
	response.headers.set("Access-Control-Allow-Headers", requestHeaders);
	response.headers.set("Access-Control-Max-Age", "86400");
	response.headers.append("Vary", "Origin");

	return response;
}

async function withCors(request: Request) {
	const response = await handler(request);
	return applyCorsHeaders(request, response);
}

export async function OPTIONS(request: Request) {
	const origin = resolveOrigin(request);
	if (!origin) {
		return new Response(null, { status: 403 });
	}

	const response = new Response(null, { status: 204 });
	response.headers.set("Access-Control-Allow-Origin", origin);
	response.headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
	response.headers.set(
		"Access-Control-Allow-Headers",
		request.headers.get("access-control-request-headers") ??
			"Content-Type,Authorization,X-Requested-With",
	);
	response.headers.set("Access-Control-Max-Age", "86400");
	response.headers.append("Vary", "Origin");
	return response;
}

export { withCors as GET, withCors as POST };
