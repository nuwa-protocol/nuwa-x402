import type {
	McpServer,
	RegisteredTool,
	ToolCallback,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { createMcpHandler } from "mcp-handler";
import type { Address } from "viem";
import { exact } from "x402/schemes";
import { processPriceToAtomicAmount } from "x402/shared";
import type {
	ERC20TokenAmount,
	PaymentPayload,
	PaymentRequirements,
} from "x402/types";
import { useFacilitator } from "x402/verify";
import z, { type ZodRawShape } from "zod";
import { createLogger } from "@/lib/logger";

const mcpLogger = createLogger(["mcp", "x402"]);

export interface FacilitatorConfig {
	url: `${string}://${string}`;
	createAuthHeaders: () => Promise<{
		verify: Record<string, string>;
		settle: Record<string, string>;
		supported: Record<string, string>;
		list?: Record<string, string>;
	}>;
}

const x402Version = 1;

type Config = NonNullable<Parameters<typeof createMcpHandler>[2]>;

export interface ServerPaymentOptions {
	price: number; // in USD
}

export interface ServerPaymentConfig {
	recipient: Address;
	facilitator: FacilitatorConfig;
	network: "base-sepolia" | "base";
}

export interface ConfigWithPayment extends Config, ServerPaymentConfig {}

export interface PaymentServerMethods {
	paidTool<Args extends ZodRawShape>(
		name: string,
		description: string,
		options: ServerPaymentOptions,
		paramsSchema: Args,
		annotations: ToolAnnotations,
		cb: ToolCallback<Args>,
	): RegisteredTool;
}

export type PaymentMcpServer = McpServer & PaymentServerMethods;

type ServerOptions = NonNullable<Parameters<typeof createMcpHandler>[1]>;

function createPaidToolMethod(
	server: McpServer,
	config: ServerPaymentConfig,
): PaymentMcpServer["paidTool"] {
	const paidTool: PaymentMcpServer["paidTool"] = (
		name,
		description,
		options,
		paramsSchema,
		annotations,
		cb,
	) => {
		const toolLogger = mcpLogger.child(name);
		const cbWithPayment: ToolCallback<any> = async (args, extra) => {
			const { verify, settle } = useFacilitator(config.facilitator);
			const makeErrorResponse = (obj: Record<string, unknown>) => {
				return {
					isError: true,
					structuredContent: obj,
					content: [{ type: "text", text: JSON.stringify(obj) }] as const,
				} as const;
			};
			toolLogger.info("Tool request received");

			const payment = extra._meta?.["x402/payment"];

			const atomicAmountForAsset = processPriceToAtomicAmount(
				options.price,
				config.network,
			);
			if ("error" in atomicAmountForAsset) {
				throw new Error("Failed to process price to atomic amount");
			}
			const { maxAmountRequired, asset } = atomicAmountForAsset;
			const paymentRequirements: PaymentRequirements = {
				scheme: "exact",
				network: config.network,
				maxAmountRequired,
				payTo: config.recipient,
				asset: asset.address,
				maxTimeoutSeconds: 300,
				resource: `mcp://tool/${name}`,
				mimeType: "application/json",
				description,
				extra: (asset as ERC20TokenAmount["asset"]).eip712,
			};

			if (!payment) {
				toolLogger.warn("No payment header found; returning payment required");
				return makeErrorResponse({
					x402Version,
					error: "_meta.x402/payment is required",
					accepts: [paymentRequirements],
				}) as any; // I genuinely dont why this is needed
			}

			let decodedPayment: PaymentPayload;
			try {
				toolLogger.debug("Decoding payment payload");
				decodedPayment = exact.evm.decodePayment(z.string().parse(payment));
				decodedPayment.x402Version = x402Version;
			} catch (error) {
				toolLogger.error("Failed to decode payment payload", error);
				return makeErrorResponse({
					x402Version,
					error: "Invalid payment",
					accepts: [paymentRequirements],
				}) as any; // I genuinely dont why this is needed
			}

			toolLogger.debug("Decoded payment payload", decodedPayment);

			try {
				toolLogger.info(
					"Verifying payment with facilitator",
					config.facilitator.url,
				);
				const verification = await verify(decodedPayment, paymentRequirements);
				if (!verification.isValid) {
					toolLogger.warn("Payment verification failed", verification);
					return makeErrorResponse({
						x402Version,
						error: verification.invalidReason,
						accepts: [paymentRequirements],
						payer: verification.payer,
					}) as any;
				}
			} catch (error) {
				toolLogger.error("Payment verification threw", error);
				return makeErrorResponse({
					x402Version,
					error: `Verification failed: ${error}`,
				}) as any;
			}

			toolLogger.info("Payment verification successful. Executing tool...");

			// Execute the tool
			let result: ReturnType<ToolCallback<any>>;
			let executionError = false;
			try {
				result = await cb(args, extra);
				// Check if the result indicates an error
				if (
					result &&
					typeof result === "object" &&
					"isError" in result &&
					result.isError
				) {
					executionError = true;
				}
			} catch (error) {
				toolLogger.error("Tool execution error", error);
				executionError = true;
				result = {
					isError: true,
					content: [{ type: "text", text: `Tool execution failed: ${error}` }],
				};
			}

			toolLogger.info("Tool execution completed. Settling payment...");

			// Only settle payment if execution was successful
			if (!executionError) {
				try {
					const settlement = await settle(decodedPayment, paymentRequirements);
					// Add settlement info to result if successful
					if (settlement.success && result) {
						// Safely add settlement info to result metadata
						if (!result._meta) {
							result._meta = {};
						}
						result._meta["x402/payment-response"] = {
							success: true,
							transaction: settlement.transaction,
							network: settlement.network,
							payer: settlement.payer,
						};
					}
				} catch (settlementError) {
					// If settlement fails, we should probably not return the result
					toolLogger.error("Settlement failed", settlementError);
					return makeErrorResponse({
						x402Version,
						error: `Settlement failed: ${settlementError}`,
						accepts: [paymentRequirements],
					}) as any;
				}
			}

			toolLogger.info("Payment settled. Returning result to client.");

			return result;
		};
		return server.tool(
			name,
			description,
			paramsSchema,
			{
				...annotations,
				paymentHint: true,
			},
			cbWithPayment as any, // I genuinely dont why this is needed
		);
	};
	return paidTool;
}

export function createPaidMcpHandler(
	initializeServer:
		| ((server: PaymentMcpServer) => Promise<void>)
		| ((server: PaymentMcpServer) => void),
	serverOptions: ServerOptions,
	config: ConfigWithPayment,
): (request: Request) => Promise<Response> {
	// Create the base paid handler
	const paidHandler = createMcpHandler(
		// Wrap the initialization to use ExtendedMcpServer
		async (server) => {
			const extendedServer = new Proxy(server as unknown as PaymentMcpServer, {
				get(target, prop, receiver) {
					if (prop === "paidTool") {
						return createPaidToolMethod(target, config);
					}
					return Reflect.get(target, prop, receiver);
				},
			}) as PaymentMcpServer;

			await initializeServer(extendedServer);
		},
		serverOptions,
		config,
	);

	return paidHandler;
}
