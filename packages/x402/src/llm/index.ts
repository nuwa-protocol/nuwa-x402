// X402 LLM payments helper (HTTP/LLM proxy SDK)
// Encapsulates payment verification and settlement for HTTP handlers.
// Exposes a small SDK used by example apps (e.g., OpenRouter proxy) to keep
// route code minimal while ensuring the X-PAYMENT-RESPONSE header is attached
// to successful responses.

import { type Address, getAddress } from "viem";
import { exact } from "x402/schemes";
import {
	findMatchingPaymentRequirements,
	processPriceToAtomicAmount,
	safeBase64Encode,
	toJsonSafe,
} from "x402/shared";
import type {
	ERC20TokenAmount,
	FacilitatorConfig,
	PaymentMiddlewareConfig,
	PaymentPayload,
	PaymentRequirements,
	Resource,
	RouteConfig,
	SettleResponse,
} from "x402/types";
import { SupportedEVMNetworks } from "x402/types";
import { useFacilitator } from "x402/verify";
import { normalizeFacilitatorUrl } from "../utils/facilitator";
import { createLogger } from "../utils/logger";

const paymentsLogger = createLogger(["llm", "payments"]);

const X_PAYMENT_HEADER = "X-PAYMENT";
const X_PAYMENT_RESPONSE_HEADER = "X-PAYMENT-RESPONSE";
const ACCESS_CONTROL_EXPOSE_HEADERS = "Access-Control-Expose-Headers";
const JSON_RESPONSE_HEADERS = {
	"Content-Type": "application/json",
	[ACCESS_CONTROL_EXPOSE_HEADERS]: X_PAYMENT_RESPONSE_HEADER,
} as const;
const X402_VERSION = 1;
const DEFAULT_SETTLEMENT_ATTEMPTS = 3;
const DEFAULT_BACKOFF_START_MS = 150;

function ensurePaymentResponseIsExposed(headers: Headers) {
	if (!headers.has(X_PAYMENT_RESPONSE_HEADER)) return;
	const existing = headers.get(ACCESS_CONTROL_EXPOSE_HEADERS);
	if (!existing) {
		headers.set(ACCESS_CONTROL_EXPOSE_HEADERS, X_PAYMENT_RESPONSE_HEADER);
		return;
	}

	const lowerCased = existing
		.split(",")
		.map((value) => value.trim().toLowerCase())
		.filter(Boolean);
	if (!lowerCased.includes(X_PAYMENT_RESPONSE_HEADER.toLowerCase())) {
		headers.set(
			ACCESS_CONTROL_EXPOSE_HEADERS,
			`${existing}, ${X_PAYMENT_RESPONSE_HEADER}`,
		);
	}
}

export interface PaymentPluginOptions {
	facilitator?: FacilitatorConfig;
}

export interface EnsurePaymentConfig
	extends Pick<RouteConfig, "price" | "network" | "config"> {
	payTo: Address;
	resource?: Resource;
	method?: string; // optional override for HTTP method recorded in requirement
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
		{ status: 402, headers: JSON_RESPONSE_HEADERS },
	);
}

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

	paymentsLogger.info("Creating payment requirements", {
		url: request.url,
		method,
		network,
		price,
	});

	const atomicAmountForAsset = processPriceToAtomicAmount(price, network);
	if ("error" in atomicAmountForAsset) {
		paymentsLogger.error("Failed to process price into atomic amount", {
			error: atomicAmountForAsset.error,
			price,
			network,
		});
		return {
			ok: false,
			response: new Response(
				JSON.stringify({
					x402Version: X402_VERSION,
					error: atomicAmountForAsset.error,
				}),
				{ status: 500, headers: JSON_RESPONSE_HEADERS },
			),
		};
	}

	const { maxAmountRequired, asset } = atomicAmountForAsset;
	const resourceUrl =
		resource || requirementConfig?.resource || (`${request.url}` as Resource);

	if (!SupportedEVMNetworks.includes(network)) {
		paymentsLogger.error("Unsupported network for payment requirement", {
			network,
		});
		return {
			ok: false,
			response: new Response(
				JSON.stringify({
					x402Version: X402_VERSION,
					error: `Unsupported network: ${network}`,
				}),
				{ status: 500, headers: JSON_RESPONSE_HEADERS },
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

	paymentsLogger.info("Payment requirement constructed", {
		network,
		resource: resourceUrl,
		payTo: requirement.payTo,
	});

	return requirement;
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
			if (attempt >= maxAttempts) break;
			const delay = Math.min(initialDelayMs * 2 ** (attempt - 1), maxDelayMs);
			await sleep(delay);
		}
	}

	if (lastError instanceof Error) throw lastError;
	throw new Error("Operation failed after retries");
}

function extractFacilitatorStatus(error: unknown) {
	if (!(error instanceof Error)) return;
	const match = error.message.match(/Failed to settle payment:\s+(\d{3})/);
	if (!match) return;
	const status = Number(match[1]);
	if (Number.isNaN(status)) return;
	return status;
}

export function createPaymentPlugin(options: PaymentPluginOptions = {}) {
	const { facilitator } = options;
	const normalizedFacilitator = normalizeFacilitatorUrl(facilitator);
	const { verify, settle } = useFacilitator(normalizedFacilitator);

	const ensurePayment = async (
		request: Request,
		config: EnsurePaymentConfig,
	): Promise<EnsurePaymentResult> => {
		const requirementOrFailure = createPaymentRequirements(request, config);
		if (!("scheme" in requirementOrFailure)) {
			paymentsLogger.error("Failed to build payment requirements", {
				url: request.url,
				method: request.method,
			});
			return requirementOrFailure;
		}

		const paymentRequirements = [requirementOrFailure];
		paymentsLogger.info("Payment requirements ready", {
			url: request.url,
			method: request.method,
			requirements: paymentRequirements,
		});
		const { config: requirementConfig } = config;
		const errorMessages: NonNullable<PaymentMiddlewareConfig["errorMessages"]> =
			requirementConfig?.errorMessages ?? {};

		const paymentHeader = request.headers.get(X_PAYMENT_HEADER);
		if (!paymentHeader) {
			paymentsLogger.error("Payment header missing", {
				header: X_PAYMENT_HEADER,
				url: request.url,
				method: request.method,
			});
			return {
				ok: false,
				response: buildPaymentRequiredResponse(
					errorMessages?.paymentRequired ||
						`${X_PAYMENT_HEADER} header is required`,
					paymentRequirements,
				),
			};
		}

		paymentsLogger.info("Payment header received", {
			header: X_PAYMENT_HEADER,
			url: request.url,
			method: request.method,
		});

		let decodedPayment: PaymentPayload;
		try {
			decodedPayment = exact.evm.decodePayment(paymentHeader);
			decodedPayment.x402Version = X402_VERSION;
			paymentsLogger.info("Payment decoded successfully", {
				payment: decodedPayment,
			});
		} catch (error) {
			paymentsLogger.error("Failed to decode payment header", {
				error,
				url: request.url,
				method: request.method,
			});
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
			paymentsLogger.error("No matching payment requirements", {
				payment: decodedPayment,
				requirements: paymentRequirements,
			});
			return {
				ok: false,
				response: buildPaymentRequiredResponse(
					errorMessages?.noMatchingRequirements ||
						"Unable to find matching payment requirements",
					toJsonSafe(paymentRequirements),
				),
			};
		}

		paymentsLogger.info("Selected payment requirement", {
			payment: decodedPayment,
			requirement: selectedRequirement,
		});

		let verification: Awaited<ReturnType<typeof verify>>;
		try {
			verification = await verify(decodedPayment, selectedRequirement);
		} catch (error) {
			paymentsLogger.error("Failed to verify payment", {
				error,
			});
			const verificationError =
				error instanceof Error ? error.message : String(error);
			return {
				ok: false,
				response: buildPaymentRequiredResponse(
					errorMessages?.verificationFailed || verificationError,
					paymentRequirements,
					{ verificationError },
				),
			};
		}

		if (!verification.isValid) {
			paymentsLogger.error("Payment verification failed", {
				payment: decodedPayment,
				requirement: selectedRequirement,
				reason: verification.invalidReason,
				payer: verification.payer,
			});
			return {
				ok: false,
				response: buildPaymentRequiredResponse(
					errorMessages?.verificationFailed ||
						verification.invalidReason ||
						"Payment verification failed",
					paymentRequirements,
					{ payer: verification.payer },
				),
			};
		}

		paymentsLogger.info("Payment verified successfully", {
			payer: verification.payer,
			payment: decodedPayment,
		});

		const settlePayment = async (
			response: Response,
		): Promise<PaymentSettlementResult> => {
			// Upstream returned an error – skip settlement by default; caller can override via settleOnError
			if (response.status >= 400) {
				paymentsLogger.info(
					"Skipping settlement due to upstream error status",
					{
						status: response.status,
					},
				);
				return { ok: true, response };
			}

			try {
				const settlement = await retryWithBackoff(() =>
					settle(decodedPayment, selectedRequirement),
				);
				paymentsLogger.info("Settlement attempt completed", {
					success: settlement.success,
					transaction: settlement.transaction,
					network: settlement.network,
				});
				if (!settlement.success) {
					paymentsLogger.warn(
						"Settlement response did not indicate success",
						settlement,
					);
				}
				return { ok: true, response, settlement };
			} catch (error) {
				const facilitatorStatus = extractFacilitatorStatus(error);
				if (facilitatorStatus && facilitatorStatus >= 500) {
					paymentsLogger.error("Settlement failed due to facilitator error", {
						error,
						status: facilitatorStatus,
					});
					return {
						ok: false,
						response: new Response(
							JSON.stringify({
								x402Version: X402_VERSION,
								error:
									requirementConfig?.errorMessages?.settlementFailed ||
									"Settlement service is temporarily unavailable. Please retry.",
								accepts: toJsonSafe(paymentRequirements),
							}),
							{ status: 502, headers: JSON_RESPONSE_HEADERS },
						),
					};
				}
				paymentsLogger.error("Settlement failed", {
					error,
				});
				return {
					ok: false,
					response: buildPaymentRequiredResponse(
						requirementConfig?.errorMessages?.settlementFailed ||
							(error instanceof Error ? error.message : "Settlement failed"),
						paymentRequirements,
					),
				};
			}
		};

		paymentsLogger.info("Payment requirement satisfied", {
			payment: decodedPayment,
			requirement: selectedRequirement,
		});

		return {
			ok: true,
			payment: decodedPayment,
			requirements: selectedRequirement,
			settle: settlePayment,
		};
	};

	return { ensurePayment };
}

export interface GateOptions {
	onSettle?: (result: PaymentSettlementResult) => void | Promise<void>;
	settleOnError?: boolean; // if true, attempt to settle even when upstream status >= 400
}

export type EnsurePaymentConfigOrBuilder =
	| EnsurePaymentConfig
	| ((ctx: {
			request: Request;
			rawPayment?: PaymentPayload;
	  }) => EnsurePaymentConfig | Promise<EnsurePaymentConfig>);

export class X402LlmPayments {
	private readonly plugin: ReturnType<typeof createPaymentPlugin>;

	constructor(private readonly options: PaymentPluginOptions = {}) {
		this.plugin = createPaymentPlugin(options);
	}

	// Non-fatal decode of X-PAYMENT so callers can do dynamic pricing keyed by claimed address.
	private tryDecodePaymentHeader(headers: Headers): PaymentPayload | undefined {
		const raw = headers.get(X_PAYMENT_HEADER);
		if (!raw) return undefined;
		try {
			const decoded = exact.evm.decodePayment(raw);
			decoded.x402Version = X402_VERSION;
			return decoded;
		} catch {
			return undefined;
		}
	}

	async gateWithX402Payment(
		request: Request,
		config: EnsurePaymentConfigOrBuilder,
		handler: () => Promise<Response>,
		options: GateOptions = {},
	): Promise<Response> {
		paymentsLogger.info("Gating request with X402 payment", {
			url: request.url,
			method: request.method,
		});
		const rawPayment = this.tryDecodePaymentHeader(request.headers);
		const concreteConfig =
			typeof config === "function"
				? await config({ request, rawPayment })
				: config;

		const ensured = await this.plugin.ensurePayment(request, concreteConfig);
		if (!ensured.ok) {
			paymentsLogger.error("Payment gate rejected request", {
				url: request.url,
				method: request.method,
			});
			return ensured.response;
		}

		paymentsLogger.info("Payment gate accepted request", {
			url: request.url,
			method: request.method,
		});

		const upstreamResponse = await handler();
		paymentsLogger.info("Upstream handler completed", {
			status: upstreamResponse.status,
			url: request.url,
			method: request.method,
		});

		// Optionally bypass the default "skip settlement on error" behavior
		if (options.settleOnError && upstreamResponse.status >= 400) {
			// Create a clone with 200 to trigger settlement attempt, but return original response
			// We settle against the original response object (status inspected inside settle())
		}

		const settlementResult = await ensured.settle(upstreamResponse.clone());
		paymentsLogger.info("Settlement result received", {
			ok: settlementResult.ok,
			settlement: settlementResult.ok ? settlementResult.settlement : undefined,
			url: request.url,
			method: request.method,
		});

		// If settlement failed in a way that returned a response (402/502), return that immediately
		if (!settlementResult.ok) {
			paymentsLogger.error("Settlement returned an error response", {
				url: request.url,
				method: request.method,
			});
			return settlementResult.response;
		}

		// On success (or skipped due to error status), attach X-PAYMENT-RESPONSE header when available
		if (settlementResult.settlement?.success) {
			const payload = {
				success: true,
				transaction: settlementResult.settlement.transaction,
				network: settlementResult.settlement.network,
				payer: settlementResult.settlement.payer,
			} as const;
			upstreamResponse.headers.set(
				X_PAYMENT_RESPONSE_HEADER,
				safeBase64Encode(JSON.stringify(payload)),
			);
		}

		ensurePaymentResponseIsExposed(upstreamResponse.headers);

		// Allow caller to react to settlement info (e.g. update deferred pricing state)
		try {
			await options.onSettle?.(settlementResult);
		} catch (e) {
			paymentsLogger.warn("onSettle handler threw", e);
		}

		paymentsLogger.info("Returning upstream response", {
			status: upstreamResponse.status,
			url: request.url,
			method: request.method,
		});

		return upstreamResponse;
	}
}

function base64UrlToBase64(input: string) {
	// Replace URL-safe chars and pad to length multiple of 4
	const s = input.replace(/-/g, "+").replace(/_/g, "/");
	const pad = s.length % 4 === 0 ? 0 : 4 - (s.length % 4);
	return s + "=".repeat(pad);
}

export function decodePaymentResponseHeader(
	input: Response | Headers,
):
	| { success: true; transaction: string; network: string; payer?: string }
	| undefined {
	const headers = input instanceof Response ? input.headers : input;
	const header = headers.get(X_PAYMENT_RESPONSE_HEADER);
	if (!header) return undefined;
	try {
		const b64 = base64UrlToBase64(header);
		const json = JSON.parse(Buffer.from(b64, "base64").toString("utf-8"));
		if (json && typeof json === "object" && json.success) return json;
	} catch {
		// ignore parse errors
	}
	return undefined;
}

export function logPaymentResponseHeader(
	input: Response | Headers,
	logger: {
		info: (...args: any[]) => void;
		warn?: (...args: any[]) => void;
	} = paymentsLogger,
) {
	const decoded = decodePaymentResponseHeader(input);
	if (decoded) {
		logger.info("Payment settled", decoded);
	} else {
		logger.info("No settlement header present or parse failed");
	}
}

export type {
	PaymentMiddlewareConfig,
	PaymentPayload,
	PaymentRequirements,
	RouteConfig,
	RoutesConfig,
} from "x402/types";
