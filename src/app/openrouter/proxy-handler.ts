import { privateKeyToAccount } from "viem/accounts";
import { applyCorsHeaders } from "@/lib/cors";
import { env } from "@/lib/env";
import {
	createPaymentPlugin,
	type EnsurePaymentConfig,
} from "./payment-plugin";

const OPENROUTER_BASE_URL = "https://openrouter.ai";
const DEFAULT_TARGET_PATH = "/api/v1/chat/completions";
const DEFAULT_PRICE = "$0.01";

const serviceAccount = privateKeyToAccount(
	env.SERVICE_PRIVATE_KEY as `0x${string}`,
);
const paymentPlugin = createPaymentPlugin();

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
	const paymentConfig = resolvePaymentConfig({
		...paymentOverrides,
	});

	const paymentResult = await paymentPlugin.ensurePayment(
		request,
		paymentConfig,
	);

	if (!paymentResult.ok) {
		return applyCorsHeaders(request, paymentResult.response);
	}

	const finalizeResponse = async (original: Response) => {
		const settlementResult = await paymentResult.settle(original);
		return applyCorsHeaders(request, settlementResult.response);
	};

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

	console.log(
		`[openrouter-proxy] Forwarding ${method} ${targetPath}${url.search}\n ${JSON.stringify(request.body)}`,
	);

	let upstreamResponse: Response;
	try {
		upstreamResponse = await fetch(targetUrl, init);
	} catch (error) {
		console.error(
			`[openrouter-proxy] Upstream request failed for ${method} ${targetPath}`,
			error,
		);
		const message =
			error instanceof Error ? error.message : "Failed to reach OpenRouter";
		const response = new Response(JSON.stringify({ error: message }), {
			status: 502,
			headers: { "Content-Type": "application/json" },
		});
		return finalizeResponse(response);
	}

	console.log(
		`[openrouter-proxy] Upstream response ${upstreamResponse.status} ${upstreamResponse.statusText} for ${method} ${targetPath}\n ${JSON.stringify(upstreamResponse.body)}`,
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

	console.log(
		`[openrouter-proxy] Response ${upstreamResponse.status} ${upstreamResponse.statusText} for ${method} ${targetPath}`,
	);

	return finalizeResponse(response);
}
