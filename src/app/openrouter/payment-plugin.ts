import { type Address, getAddress } from "viem";
import { createLogger } from "@/lib/logger";
import { exact } from "x402/schemes";
import {
	findMatchingPaymentRequirements,
	processPriceToAtomicAmount,
	toJsonSafe,
} from "x402/shared";
import {
	type ERC20TokenAmount,
	type FacilitatorConfig,
	type PaymentMiddlewareConfig,
	type PaymentPayload,
	type PaymentRequirements,
	type Resource,
	type RouteConfig,
	type SettleResponse,
	SupportedEVMNetworks,
} from "x402/types";
import { useFacilitator } from "x402/verify";

const paymentLogger = createLogger(["openrouter", "payment"]);

const X_PAYMENT_HEADER = "X-PAYMENT";
const JSON_CONTENT_TYPE = { "Content-Type": "application/json" };
const X402_VERSION = 1;
const DEFAULT_SETTLEMENT_ATTEMPTS = 3;
const DEFAULT_BACKOFF_START_MS = 150;

export interface PaymentPluginOptions {
	facilitator?: FacilitatorConfig;
}

export interface EnsurePaymentConfig
	extends Pick<RouteConfig, "price" | "network" | "config"> {
	payTo: Address;
	resource?: Resource;
	method?: string;
}

export interface PaymentFailureResult {
	ok: false;
	response: Response;
}

export interface PaymentSettlementSuccess {
	ok: true;
	response: Response;
	settlement?: SettleResponse;
}

export interface PaymentSettlementFailure {
	ok: false;
	response: Response;
}

export type PaymentSettlementResult =
	| PaymentSettlementSuccess
	| PaymentSettlementFailure;

export interface PaymentSuccessResult {
	ok: true;
	payment: PaymentPayload;
	requirements: PaymentRequirements;
	settle(response: Response): Promise<PaymentSettlementResult>;
}

export type EnsurePaymentResult = PaymentFailureResult | PaymentSuccessResult;

function createPaymentRequirements(
	request: Request,
	config: EnsurePaymentConfig,
): PaymentFailureResult | PaymentRequirements {
	const requirementConfig = (config.config ?? {}) as
		| PaymentMiddlewareConfig
		| undefined;
	const { price, network, payTo, resource } = config;
	const {
		description,
		mimeType,
		maxTimeoutSeconds,
		inputSchema,
		outputSchema,
		errorMessages,
		discoverable,
	} = requirementConfig ?? {};
	const method = config.method ?? request.method.toUpperCase();

	const atomicAmountForAsset = processPriceToAtomicAmount(price, network);
	if ("error" in atomicAmountForAsset) {
		return {
			ok: false,
			response: new Response(
				JSON.stringify({
					x402Version: X402_VERSION,
					error: atomicAmountForAsset.error,
				}),
				{
					status: 500,
					headers: JSON_CONTENT_TYPE,
				},
			),
		};
	}

	const { maxAmountRequired, asset } = atomicAmountForAsset;

	const resourceUrl =
		resource || requirementConfig?.resource || (`${request.url}` as Resource);

	if (!SupportedEVMNetworks.includes(network)) {
		return {
			ok: false,
			response: new Response(
				JSON.stringify({
					x402Version: X402_VERSION,
					error: `Unsupported network: ${network}`,
				}),
				{
					status: 500,
					headers: JSON_CONTENT_TYPE,
				},
			),
		};
	}

	const requirement: PaymentRequirements = {
		scheme: "exact",
		network,
		maxAmountRequired,
		resource: resourceUrl,
		description: description ?? "",
		mimeType: mimeType ?? "application/json",
		payTo: getAddress(payTo),
		maxTimeoutSeconds: maxTimeoutSeconds ?? 300,
		asset: getAddress(asset.address),
		outputSchema: {
			input: {
				type: "http",
				method,
				discoverable: discoverable ?? true,
				...inputSchema,
			},
			output: outputSchema,
		},
		extra: (asset as ERC20TokenAmount["asset"]).eip712,
	};

	return requirement;
}

function buildPaymentRequiredResponse(
	error: string,
	accepts: unknown,
	additional?: Record<string, unknown>,
) {
	return new Response(
		JSON.stringify({
			x402Version: X402_VERSION,
			error,
			accepts,
			...additional,
		}),
		{
			status: 402,
			headers: JSON_CONTENT_TYPE,
		},
	);
}

interface RetryOptions {
	maxAttempts?: number;
	initialDelayMs?: number;
	maxDelayMs?: number;
}

async function sleep(delay: number) {
	await new Promise((resolve) => setTimeout(resolve, delay));
}

async function retryWithBackoff<T>(
	operation: () => Promise<T>,
	options: RetryOptions = {},
) {
	const {
		maxAttempts = DEFAULT_SETTLEMENT_ATTEMPTS,
		initialDelayMs = DEFAULT_BACKOFF_START_MS,
		maxDelayMs = 1000,
	} = options;
	let attempt = 0;
	let lastError: unknown;

	while (attempt < maxAttempts) {
		try {
			return await operation();
		} catch (error) {
			lastError = error;
			attempt += 1;

			if (attempt >= maxAttempts) {
				break;
			}

			const delay = Math.min(initialDelayMs * 2 ** (attempt - 1), maxDelayMs);
			await sleep(delay);
		}
	}

	if (lastError instanceof Error) {
		throw lastError;
	}

	throw new Error("Operation failed after retries");
}

function extractFacilitatorStatus(error: unknown) {
	if (!(error instanceof Error)) {
		return;
	}

	const match = error.message.match(/Failed to settle payment:\s+(\d{3})/);
	if (!match) {
		return;
	}

	const status = Number(match[1]);
	if (Number.isNaN(status)) {
		return;
	}

	return status;
}

export function createPaymentPlugin(options: PaymentPluginOptions = {}) {
	const { facilitator } = options;
	const { verify, settle } = useFacilitator(facilitator);

	const ensurePayment = async (
		request: Request,
		config: EnsurePaymentConfig,
	): Promise<EnsurePaymentResult> => {
		const requirementOrFailure = createPaymentRequirements(request, config);
		if (!("scheme" in requirementOrFailure)) {
			return requirementOrFailure;
		}

		const paymentRequirements = [requirementOrFailure];
		const { config: requirementConfig } = config;
		const errorMessages: NonNullable<PaymentMiddlewareConfig["errorMessages"]> =
			requirementConfig?.errorMessages ?? {};

		const paymentHeader = request.headers.get(X_PAYMENT_HEADER);
		if (!paymentHeader) {
			return {
				ok: false,
				response: buildPaymentRequiredResponse(
					errorMessages?.paymentRequired ||
						`${X_PAYMENT_HEADER} header is required`,
					paymentRequirements,
				),
			};
		}

		let decodedPayment: PaymentPayload;
		try {
			decodedPayment = exact.evm.decodePayment(paymentHeader);
			decodedPayment.x402Version = X402_VERSION;
		} catch (error) {
			return {
				ok: false,
				response: buildPaymentRequiredResponse(
					errorMessages?.invalidPayment ||
						(error instanceof Error ? error.message : "Invalid payment"),
					paymentRequirements,
				),
			};
		}

		const selectedRequirement = findMatchingPaymentRequirements(
			paymentRequirements,
			decodedPayment,
		);

		if (!selectedRequirement) {
			return {
				ok: false,
				response: buildPaymentRequiredResponse(
					errorMessages?.noMatchingRequirements ||
						"Unable to find matching payment requirements",
					toJsonSafe(paymentRequirements),
				),
			};
		}

		const verification = await verify(decodedPayment, selectedRequirement);
		if (!verification.isValid) {
			return {
				ok: false,
				response: buildPaymentRequiredResponse(
					errorMessages?.verificationFailed ||
						verification.invalidReason ||
						"Payment verification failed",
					paymentRequirements,
					{
						payer: verification.payer,
					},
				),
			};
		}

		const settlePayment = async (
			response: Response,
		): Promise<PaymentSettlementResult> => {
			if (response.status >= 400) {
				return { ok: true, response };
			}

			try {
				const settlement = await retryWithBackoff(
					() => settle(decodedPayment, selectedRequirement),
				);

					if (!settlement.success) {
						paymentLogger.warn(
							"Settlement response did not indicate success",
							settlement,
						);
					}

				return { ok: true, response, settlement };
			} catch (error) {
				const facilitatorStatus = extractFacilitatorStatus(error);
				if (facilitatorStatus && facilitatorStatus >= 500) {
					return {
						ok: false,
						response: new Response(
							JSON.stringify({
								x402Version: X402_VERSION,
								error:
									errorMessages?.settlementFailed ||
									"Settlement service is temporarily unavailable. Please retry.",
								accepts: toJsonSafe(paymentRequirements),
							}),
							{
								status: 502,
								headers: JSON_CONTENT_TYPE,
							},
						),
					};
				}

				return {
					ok: false,
					response: buildPaymentRequiredResponse(
						errorMessages?.settlementFailed ||
							(error instanceof Error ? error.message : "Settlement failed"),
						paymentRequirements,
					),
				};
			}
		};

		return {
			ok: true,
			payment: decodedPayment,
			requirements: selectedRequirement,
			settle: settlePayment,
		};
	};

	return {
		ensurePayment,
	};
}

export type {
	PaymentMiddlewareConfig,
	PaymentPayload,
	PaymentRequirements,
	RouteConfig,
	RoutesConfig,
} from "x402/types";
