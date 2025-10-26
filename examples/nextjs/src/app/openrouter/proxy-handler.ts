import {
    type EnsurePaymentConfig,
    type PaymentSettlementResult,
    X402LlmPayments,
    logPaymentResponseHeader,
} from "@nuwa-ai/x402/llm";
import { privateKeyToAccount } from "viem/accounts";
import { applyCorsHeaders } from "@/lib/cors";
import { env } from "@/lib/env";
import { createLogger } from "@/lib/logger";

const proxyLogger = createLogger(["openrouter", "proxy"]);
const settlementLogger = proxyLogger.child("settlement");

const OPENROUTER_BASE_URL = "https://openrouter.ai";
const DEFAULT_TARGET_PATH = "/api/v1/chat/completions";
const DEFAULT_PRICE = "$0.01";

const serviceAccount = privateKeyToAccount(
	env.SERVICE_PRIVATE_KEY as `0x${string}`,
);
const payments = new X402LlmPayments();

const defaultPaymentConfig: EnsurePaymentConfig = {
	payTo: serviceAccount.address,
	price: DEFAULT_PRICE,
	network: env.NETWORK,
	config: {
		description: "Access to OpenRouter proxy",
		mimeType: "application/json",
	},
};

function resolvePaymentConfig(
	overrides: Partial<EnsurePaymentConfig> = {},
): EnsurePaymentConfig {
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

	headers.set("Authorization", `Bearer ${env.OPENROUTER_API_KEY}`);

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
	const paymentConfig = resolvePaymentConfig({ ...paymentOverrides });

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

	const onSettle = (settlementResult: PaymentSettlementResult) => {
		const logPayload: Record<string, unknown> = {
			ok: settlementResult.ok,
			responseStatus: settlementResult.response.status,
		};
		if (settlementResult.ok && settlementResult.settlement) {
			logPayload.transaction = settlementResult.settlement.transaction;
			logPayload.network = settlementResult.settlement.network;
			logPayload.payer = settlementResult.settlement.payer;
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

		return response;
	};

    const paymentGated = await payments.gateWithX402Payment(
        request,
        paymentConfig,
        () => makeUpstream(),
        {
            onSettle,
        },
    );

    // Log the X-PAYMENT-RESPONSE header (if present) for observability
    // This works in conjunction with the middleware always settling before return.
    logPaymentResponseHeader(paymentGated, settlementLogger);

    return finalizeResponse(paymentGated);
}
