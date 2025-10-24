import { facilitator } from "@coinbase/x402";
import { privateKeyToAccount } from "viem/accounts";
import z from "zod";
import {
	createPaidMcpHandler,
	type FacilitatorConfig,
} from "./x402-mcp-server";
import { env } from "@/lib/env";
import {
	applyCorsHeaders,
	createCorsPreflightResponse,
} from "@/lib/cors";

const sellerAccount = privateKeyToAccount(
	env.SERVICE_PRIVATE_KEY as `0x${string}`,
);
const network = env.NETWORK;

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

async function withCors(request: Request) {
	const response = await handler(request);
	return applyCorsHeaders(request, response);
}

export async function OPTIONS(request: Request) {
	return createCorsPreflightResponse(request);
}

export { withCors as GET, withCors as POST };
