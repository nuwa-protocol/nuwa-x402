import {
    type EnsurePaymentConfig,
    logPaymentResponseHeader,
    type PaymentSettlementResult,
    X402LlmPayments,
} from "@nuwa-ai/x402/llm";
import { privateKeyToAccount } from "viem/accounts";
import { applyCorsHeaders } from "@/lib/cors";
import { getEnv } from "@/lib/env";
import { createLogger } from "@/lib/logger";

const proxyLogger = createLogger(["openrouter", "proxy"]);
const settlementLogger = proxyLogger.child("settlement");

const OPENROUTER_BASE_URL = "https://openrouter.ai";
const DEFAULT_TARGET_PATH = "/api/v1/chat/completions";
const DEFAULT_PRICE = "$0.01";

const payments = new X402LlmPayments();

let cachedServiceAccount: ReturnType<typeof privateKeyToAccount> | null = null;

function getServiceAccount() {
	if (!cachedServiceAccount) {
		const { SERVICE_PRIVATE_KEY } = getEnv();
		cachedServiceAccount = privateKeyToAccount(
			SERVICE_PRIVATE_KEY as `0x${string}`,
		);
	}
	return cachedServiceAccount;
}

function getDefaultPaymentConfig(): EnsurePaymentConfig {
	const env = getEnv();
	const account = getServiceAccount();
	return {
		payTo: account.address,
		price: DEFAULT_PRICE,
		network: env.NETWORK,
		config: {
			description: "Access to OpenRouter proxy",
			mimeType: "application/json",
		},
	};
}

// In-memory IOU store keyed by payer address (USD). Replace with Redis/DB in prod.
const pendingByAddress = new Map<string, number>();
function getOwedUSD(addr: string) {
    return pendingByAddress.get(addr) ?? 0;
}
function setOwedUSD(addr: string, usd: number) {
    pendingByAddress.set(addr, usd);
}

// Extract the USD cost of a response. Stubbed – implement OpenRouter usage parsing later.
async function extractCostUSD(resp: Response, req: Request): Promise<number> {
    try {
        const text = await resp.clone().text();
        if (!text) return 0;
        const json = JSON.parse(text);
        // TODO: map OpenRouter usage/model pricing to USD
        // const usage = json.usage; // prompt_tokens, completion_tokens
        // return computeUSD(usage, json.model);
        return 0;
    } catch {
        return 0;
    }
}

function resolvePaymentConfig(
	overrides: Partial<EnsurePaymentConfig> = {},
): EnsurePaymentConfig {
	const defaultPaymentConfig = getDefaultPaymentConfig();
	return {
		...defaultPaymentConfig,
		...overrides,
		config: {
			...defaultPaymentConfig.config,
			...overrides.config,
		},
	} as EnsurePaymentConfig;
}

function buildForwardHeaders(request: Request) {
	const { OPENROUTER_API_KEY } = getEnv();
	const headers = new Headers();
	for (const [key, value] of request.headers.entries()) {
		if (["host", "content-length"].includes(key.toLowerCase())) {
			continue;
		}
		headers.set(key, value);
	}

	if (!headers.has("x-title")) {
		headers.set("x-title", "x402-openrouter-proxy");
	}

	headers.set("Authorization", `Bearer ${OPENROUTER_API_KEY}`);

	return headers;
}

function resolveTargetPath(pathSegments: string[]) {
	if (pathSegments.length === 0) {
		return DEFAULT_TARGET_PATH;
	}

	const joined = pathSegments.join("/");
	return joined.startsWith("/") ? joined : `/${joined}`;
}

export async function forwardOpenRouter(
    request: Request,
    pathSegments: string[] = [],
    paymentOverrides: Partial<EnsurePaymentConfig> = {},
) {

	const finalizeResponse = (original: Response) =>
		applyCorsHeaders(request, original);

	const url = new URL(request.url);
	const targetPath = resolveTargetPath(pathSegments);
	const targetUrl = `${OPENROUTER_BASE_URL}${targetPath}${url.search}`;
	const method = request.method.toUpperCase();
	const headers = buildForwardHeaders(request);

	const init: RequestInit & { duplex?: "half" } = {
		method,
		headers,
	};

	if (request.body && method !== "GET" && method !== "HEAD") {
		init.body = request.body;
		init.duplex = "half";
	}

	proxyLogger.info(
		`Forwarding ${method} ${targetPath}${url.search}`,
		JSON.stringify(request.body),
	);

    let nextCostUSD: number | null = null;

    const onSettle = (settlementResult: PaymentSettlementResult) => {
        const logPayload: Record<string, unknown> = {
            ok: settlementResult.ok,
            responseStatus: settlementResult.response.status,
        };
        if (settlementResult.ok && settlementResult.settlement) {
            logPayload.transaction = settlementResult.settlement.transaction;
            logPayload.network = settlementResult.settlement.network;
            logPayload.payer = settlementResult.settlement.payer;
            // Store the next owed USD for this verified payer
            const payer = settlementResult.settlement.payer as string | undefined;
            if (payer && nextCostUSD != null) {
                setOwedUSD(payer, nextCostUSD);
            }
        }
        if (settlementResult.ok) {
            settlementLogger.info("Settlement finished", logPayload);
        } else {
            settlementLogger.warn("Settlement failed", logPayload);
        }
    };

    const makeUpstream = async () => {
        let upstreamResponse: Response;
        try {
            upstreamResponse = await fetch(targetUrl, init);
        } catch (error) {
			proxyLogger.error(
				`Upstream request failed for ${method} ${targetPath}`,
				error,
			);
			const message =
				error instanceof Error ? error.message : "Failed to reach OpenRouter";
			return new Response(JSON.stringify({ error: message }), {
				status: 502,
				headers: { "Content-Type": "application/json" },
			});
		}

		proxyLogger.info(
			`Upstream response ${upstreamResponse.status} ${upstreamResponse.statusText} for ${method} ${targetPath}`,
			JSON.stringify(upstreamResponse.body),
		);

		const responseHeaders = new Headers(upstreamResponse.headers);
		responseHeaders.delete("content-security-policy");
		responseHeaders.delete("content-length");
		responseHeaders.delete("content-encoding");
		responseHeaders.delete("transfer-encoding");

        const response = new Response(upstreamResponse.body, {
            status: upstreamResponse.status,
            statusText: upstreamResponse.statusText,
            headers: responseHeaders,
        });

        proxyLogger.info(
            `Response ${upstreamResponse.status} ${upstreamResponse.statusText} for ${method} ${targetPath}`,
        );

        // Compute the USD cost of THIS request; will be charged on next call
        nextCostUSD = await extractCostUSD(response, request);
        return response;
    };

    // Dynamic pricing per caller – use claimed address in rawPayment to form config
    const dynamicConfig = async (ctx: { request: Request; rawPayment?: any }) => {
        const env = getEnv();
        const account = getServiceAccount();
        const claimed = ctx.rawPayment?.payer ?? ctx.rawPayment?.from ?? ctx.rawPayment?.owner;
        const owedUSD = claimed ? getOwedUSD(claimed) : 0;
        return {
            payTo: account.address,
            price: owedUSD,
            network: env.NETWORK,
            config: {
                description: "Access to OpenRouter proxy",
                mimeType: "application/json",
                ...(paymentOverrides.config || {}),
            },
            ...paymentOverrides,
        } as EnsurePaymentConfig;
    };

    const paymentGated = await payments.gateWithX402Payment(
        request,
        dynamicConfig,
        () => makeUpstream(),
        {
            onSettle,
            // settleOnError: true, // enable if you want to settle prior debt even when upstream fails
        },
    );

	// Log the X-PAYMENT-RESPONSE header (if present) for observability.
	// This works in conjunction with the middleware always settling before return.
	logPaymentResponseHeader(paymentGated, settlementLogger);

	return finalizeResponse(paymentGated);
}
