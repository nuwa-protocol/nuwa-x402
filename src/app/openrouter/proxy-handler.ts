import { applyCorsHeaders } from "@/lib/cors";
import { env } from "@/lib/env";

const OPENROUTER_BASE_URL = "https://openrouter.ai";
const DEFAULT_TARGET_PATH = "/api/v1/chat/completions";

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
) {
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
		return applyCorsHeaders(request, response);
	}

	const responseHeaders = new Headers(upstreamResponse.headers);
	responseHeaders.delete("content-security-policy");
	responseHeaders.delete("content-length");

	const response = new Response(upstreamResponse.body, {
		status: upstreamResponse.status,
		statusText: upstreamResponse.statusText,
		headers: responseHeaders,
	});

	console.log(
		`[openrouter-proxy] Response ${upstreamResponse.status} ${upstreamResponse.statusText} for ${method} ${targetPath}`,
	);

	return applyCorsHeaders(request, response);
}
