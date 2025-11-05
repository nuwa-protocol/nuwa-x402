import { applyCorsHeaders } from "@/lib/cors";
import { type Env, getEnv } from "@/lib/env";
import { createLogger } from "@/lib/logger";
import {
	type EnsurePaymentConfig,
	logPaymentResponseHeader,
	X402LlmPayments,
} from "@nuwa-ai/x402/llm";
import type { FacilitatorConfig } from "@nuwa-ai/x402/mcp";
import { privateKeyToAccount } from "viem/accounts";

const proxyLogger = createLogger(["openrouter", "proxy"]);
const settlementLogger = proxyLogger.child("settlement");

const OPENROUTER_BASE_URL = "https://openrouter.ai";
const DEFAULT_TARGET_PATH = "/api/v1/chat/completions";
const DEFAULT_PRICE = "$0.01";

const env = getEnv();

// Optional: allow a custom facilitator defined in .env for X Layer support
function resolveFacilitator(env: Env): FacilitatorConfig | undefined {
	const url = env.X402_FACILITATOR_URL;
	if (!url) return undefined;
	return {
		url,
		async createAuthHeaders() {
			return {
				verify: {},
				settle: {},
				supported: {},
			};
		},
	} satisfies FacilitatorConfig;
}

const serviceAccount = privateKeyToAccount(
	env.SERVICE_PRIVATE_KEY as `0x${string}`,
);
const payments = new X402LlmPayments({ facilitator: resolveFacilitator(env) });

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

	// Define the upstream handler once; payments SDK will verify, run this handler, settle, and attach the header
	const upstreamHandler = async () => {
		const url = new URL(request.url);
		const targetPath = resolveTargetPath(pathSegments);
		const targetUrl = `${OPENROUTER_BASE_URL}${targetPath}${url.search}`;
		const method = request.method.toUpperCase();
		const headers = buildForwardHeaders(request);

		const init: RequestInit & { duplex?: "half" } = { method, headers };
		if (request.body && method !== "GET" && method !== "HEAD") {
			init.body = request.body;
			init.duplex = "half";
		}

		proxyLogger.info(
			`Forwarding ${method} ${targetPath}${url.search}`,
			JSON.stringify(request.body),
		);

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

		// Sanitize hop-by-hop headers
		const responseHeaders = new Headers(upstreamResponse.headers);
		responseHeaders.delete("content-security-policy");
		responseHeaders.delete("content-length");
		responseHeaders.delete("content-encoding");
		responseHeaders.delete("transfer-encoding");

		return new Response(upstreamResponse.body, {
			status: upstreamResponse.status,
			statusText: upstreamResponse.statusText,
			headers: responseHeaders,
		});
	};

	const result = await payments.gateWithX402Payment(
		request,
		paymentConfig,
		upstreamHandler,
		{
			onSettle: (settlementResult) => {
				// Basic structured log mirroring previous behavior
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
			},
		},
	);

	// Ensure CORS is set and expose the payment response header to browsers
	const withCors = applyCorsHeaders(request, result);
	const exposeHeaders = withCors.headers.get("Access-Control-Expose-Headers");
	const paymentHeaderName = "X-PAYMENT-RESPONSE";
	if (!exposeHeaders) {
		withCors.headers.set("Access-Control-Expose-Headers", paymentHeaderName);
	} else {
		const tokens = exposeHeaders
			.split(",")
			.map((value) => value.trim().toLowerCase())
			.filter(Boolean);
		if (!tokens.includes(paymentHeaderName.toLowerCase())) {
			withCors.headers.set(
				"Access-Control-Expose-Headers",
				`${exposeHeaders}, ${paymentHeaderName}`,
			);
		}
	}
	try {
		logPaymentResponseHeader(withCors.headers, settlementLogger as any);
	} catch {}
	return withCors;
}
