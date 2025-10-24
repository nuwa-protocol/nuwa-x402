import { facilitator } from "@coinbase/x402";
import { privateKeyToAccount } from "viem/accounts";
import z from "zod";
import {
	createPaidMcpHandler,
	type FacilitatorConfig,
} from "./x402-mcp-server";

const sellerAccount = privateKeyToAccount(
	process.env.SERVICE_PRIVATE_KEY as `0x${string}`,
);
const network = "base-sepolia";

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
		facilitator: facilitator as unknown as FacilitatorConfig,
		network,
	},
);

const localhostPrefixes = ["http://localhost", "http://127.0.0.1"];

function applyCorsHeaders(request: Request, response: Response) {
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
