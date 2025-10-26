import { type Address, getAddress } from "viem";
import { exact } from "x402/schemes";
import {
	findMatchingPaymentRequirements,
	processPriceToAtomicAmount,
	toJsonSafe,
	safeBase64Encode,
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
import { createLogger } from "../utils/logger";

const paymentLogger = createLogger(["llm", "payment"]);

const X_PAYMENT_HEADER = "X-PAYMENT";
const JSON_CONTENT_TYPE = { "Content-Type": "application/json" } as const;
const X_PAYMENT_RESPONSE_HEADER = "X-PAYMENT-RESPONSE" as const;
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
					error: (atomicAmountForAsset as any).error,
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
		description: description ?? "",
		resource: resourceUrl,
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
	if (!(error instanceof Error)) return;

	const match = (error.message || "").match(
		/Failed to settle payment:\s+(\d{3})/,
	);
	if (!match) return;

	const status = Number(match[1]);
	if (Number.isNaN(status)) return;

	return status;
}

export class X402LlmPayments {
	private readonly headerName: string;
	private readonly verify: ReturnType<typeof useFacilitator>["verify"];
	private readonly settle: ReturnType<typeof useFacilitator>["settle"];

	constructor(options: PaymentPluginOptions = {}) {
		const { facilitator } = options;
		const helper = useFacilitator(facilitator);
		this.verify = helper.verify;
		this.settle = helper.settle;
		this.headerName = X_PAYMENT_HEADER;
	}

	createRequirements(
		request: Request,
		config: EnsurePaymentConfig,
	): PaymentFailureResult | PaymentRequirements {
		return createPaymentRequirements(request, config);
	}

	checkPaymentHeader(
		request: Request,
		requirements: PaymentRequirements[],
		options: {
			headerName?: string;
			errorMessages?: NonNullable<PaymentMiddlewareConfig["errorMessages"]>;
		} = {},
	): PaymentFailureResult | { ok: true; payment: PaymentPayload } {
		const header = request.headers.get(options.headerName ?? this.headerName);
		const errorMessages = options.errorMessages ?? ({} as any);
		if (!header) {
			return {
				ok: false,
				response: buildPaymentRequiredResponse(
					(errorMessages as any).paymentRequired ||
						`${options.headerName ?? this.headerName} header is required`,
					requirements,
				),
			};
		}

		try {
			const decoded = exact.evm.decodePayment(header);
			(decoded as any).x402Version = X402_VERSION;
			return { ok: true, payment: decoded };
		} catch (error) {
			return {
				ok: false,
				response: buildPaymentRequiredResponse(
					(errorMessages as any)?.invalidPayment ||
						(error instanceof Error ? error.message : "Invalid payment"),
					requirements,
				),
			};
		}
	}

	async verifyPayment(
		payment: PaymentPayload,
		requirements: PaymentRequirements[],
		options: {
			errorMessages?: NonNullable<PaymentMiddlewareConfig["errorMessages"]>;
		} = {},
	): Promise<
		PaymentFailureResult | { ok: true; requirement: PaymentRequirements }
	> {
		const errorMessages = options.errorMessages ?? ({} as any);
		const selectedRequirement = findMatchingPaymentRequirements(
			requirements,
			payment,
		);
		if (!selectedRequirement) {
			return {
				ok: false,
				response: buildPaymentRequiredResponse(
					(errorMessages as any)?.noMatchingRequirements ||
						"Unable to find matching payment requirements",
					toJsonSafe(requirements),
				),
			};
		}

		const verification = await this.verify(payment, selectedRequirement);
		if (!verification.isValid) {
			return {
				ok: false,
				response: buildPaymentRequiredResponse(
					(errorMessages as any)?.verificationFailed ||
						verification.invalidReason ||
						"Payment verification failed",
					requirements,
					{ payer: verification.payer },
				),
			};
		}

		return { ok: true, requirement: selectedRequirement };
	}

    async settlePayment(
        payment: PaymentPayload,
        requirement: PaymentRequirements,
        response: Response,
        options: {
            retry?: RetryOptions;
            errorMessages?: NonNullable<PaymentMiddlewareConfig["errorMessages"]>;
        } = {},
    ): Promise<PaymentSettlementResult> {
        const { retry = {}, errorMessages = {} as any } = options;
        if (response.status >= 400) {
            return { ok: true, response };
        }

        try {
            const settlement = await retryWithBackoff(
                () => this.settle(payment, requirement),
                retry,
            );

            if (!(settlement as any).success) {
                paymentLogger.warn(
                    "Settlement response did not indicate success",
                    settlement as any,
                );
            }

            // If settlement is successful, forward the X-PAYMENT-RESPONSE header to client
            // This mirrors the Next.js middleware behavior in x402-next.ts
            if ((settlement as any).success) {
                try {
                    const payload = {
                        success: true,
                        transaction: (settlement as any).transaction,
                        network: (settlement as any).network,
                        payer: (settlement as any).payer,
                    };
                    response.headers.set(
                        X_PAYMENT_RESPONSE_HEADER,
                        safeBase64Encode(JSON.stringify(payload)),
                    );
                } catch (_) {
                    // Header population failure should not break happy path
                }
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
                                (error as any)?.message ||
                                (errorMessages as any)?.settlementFailed ||
                                "Settlement service is temporarily unavailable. Please retry.",
                            accepts: toJsonSafe([requirement]),
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
					(errorMessages as any)?.settlementFailed ||
						(error instanceof Error ? error.message : "Settlement failed"),
					[requirement],
				),
			};
		}
	}

	// Convenience API matching previous behavior
	async ensurePayment(
		request: Request,
		config: EnsurePaymentConfig,
	): Promise<EnsurePaymentResult> {
		const requirementOrFailure = this.createRequirements(request, config);
		if (!("scheme" in (requirementOrFailure as any))) {
			return requirementOrFailure as PaymentFailureResult;
		}
		const requirement = requirementOrFailure as PaymentRequirements;
		const errorMessages: NonNullable<PaymentMiddlewareConfig["errorMessages"]> =
			((config as any).config?.errorMessages ?? {}) as any;

		const headerCheck = this.checkPaymentHeader(request, [requirement], {
			errorMessages,
		});
		if (!("ok" in headerCheck) || !headerCheck.ok) {
			return headerCheck as PaymentFailureResult;
		}

		const verification = await this.verifyPayment(
			headerCheck.payment,
			[requirement],
			{
				errorMessages,
			},
		);
		if (!("ok" in verification) || !verification.ok) {
			return verification as PaymentFailureResult;
		}

		const settle = async (response: Response) =>
			this.settlePayment(
				headerCheck.payment,
				verification.requirement,
				response,
				{
					errorMessages,
				},
			);

		return {
			ok: true,
			payment: headerCheck.payment,
			requirements: verification.requirement,
			settle,
		} as PaymentSuccessResult;
	}

    /**
     * Gate a request with x402 payment checks and settlement orchestration.
     * - Runs: createRequirements -> checkPaymentHeader -> verifyPayment
     * - Calls your handler on success to produce a Response
     * - Always settles payment BEFORE returning a Response to the client.
     *   We removed the "post-return" settlement path to ensure clients always
     *   receive the settlement result header when the request succeeds.
     */
    async gateWithX402Payment(
        request: Request,
        config: EnsurePaymentConfig,
        handler: (ctx: {
            payment: PaymentPayload;
            requirement: PaymentRequirements;
        }) => Promise<Response>,
        options: {
            // settlement option removed – we always settle before returning
            headerName?: string;
            retry?: RetryOptions;
            errorMessages?: NonNullable<PaymentMiddlewareConfig["errorMessages"]>;
            onSettle?: (result: PaymentSettlementResult) => void;
            onSettleError?: (error: unknown) => void;
        } = {},
    ): Promise<Response> {
        const requirementOrFailure = this.createRequirements(request, config);
        if (!("scheme" in (requirementOrFailure as any))) {
            return (requirementOrFailure as PaymentFailureResult).response;
        }
        const requirement = requirementOrFailure as PaymentRequirements;

		const errorMessages =
			options.errorMessages ??
			(config as any).config?.errorMessages ??
			({} as any);

		const headerCheck = this.checkPaymentHeader(request, [requirement], {
			headerName: options.headerName,
			errorMessages,
		});
		if (!("ok" in headerCheck) || !headerCheck.ok) {
			return (headerCheck as PaymentFailureResult).response;
		}

		const verification = await this.verifyPayment(
			headerCheck.payment,
			[requirement],
			{
				errorMessages,
			},
		);
		if (!("ok" in verification) || !verification.ok) {
			return (verification as PaymentFailureResult).response;
		}

        const upstreamResponse = await handler({
            payment: headerCheck.payment,
            requirement: verification.requirement,
        });
        // Always settle BEFORE returning to the client. If settlement fails,
        // return the error Response (usually a 4xx/5xx). On success we attach
        // the X-PAYMENT-RESPONSE header to the response returned to client.
        const settlement = await this.settlePayment(
            headerCheck.payment,
            verification.requirement,
            upstreamResponse,
            { retry: options.retry, errorMessages },
        );
        options.onSettle?.(settlement);
        return settlement.response;
    }
}

export function createPaymentPlugin(options: PaymentPluginOptions = {}) {
    return new X402LlmPayments(options);
}

/**
 * Decode the X-PAYMENT-RESPONSE header into a JSON object.
 * Returns undefined if the header is missing or cannot be decoded/parsed.
 */
export function decodePaymentResponseHeader(
    source: Response | Headers,
): { success: boolean; transaction?: string; network?: string; payer?: string } | undefined {
    const headers = source instanceof Response ? source.headers : source;
    const value = headers.get(X_PAYMENT_RESPONSE_HEADER);
    if (!value) return undefined;

    try {
        // Accept both base64 and base64url
        let b64 = value.replace(/-/g, "+").replace(/_/g, "/");
        const pad = b64.length % 4;
        if (pad) b64 += "=".repeat(4 - pad);

        let json: string;
        // Use atob in runtimes where it's available (edge), else Buffer (node)
        if (typeof atob === "function") {
            json = atob(b64);
        } else {
            const Buf = (globalThis as any).Buffer;
            if (!Buf?.from) return undefined;
            const buf = Buf.from(b64, "base64");
            json = buf.toString("utf8");
        }
        return JSON.parse(json);
    } catch {
        return undefined;
    }
}

/**
 * Convenience helper to log the decoded X-PAYMENT-RESPONSE header.
 * Returns true if the header was present and logged, false otherwise.
 */
export function logPaymentResponseHeader(
    source: Response | Headers,
    logger: { info: (...args: any[]) => void; debug?: (...args: any[]) => void } = paymentLogger,
): boolean {
    const decoded = decodePaymentResponseHeader(source);
    if (!decoded) {
        logger?.debug?.("No X-PAYMENT-RESPONSE header present");
        return false;
    }
    logger.info("X-PAYMENT-RESPONSE", decoded);
    return true;
}

export type {
    // Also re-export FacilitatorConfig to consumers
    FacilitatorConfig,
    PaymentMiddlewareConfig,
    PaymentPayload,
	PaymentRequirements,
	RouteConfig,
	SettleResponse,
} from "x402/types";
