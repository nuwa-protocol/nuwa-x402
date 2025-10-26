import { getEnv } from "@/lib/env";

const localhostPrefixes = ["http://localhost", "http://127.0.0.1"];

export function resolveAllowedOrigin(request: Request) {
	const { ALLOWED_ORIGIN } = getEnv();
	const requestOrigin = request.headers.get("origin");
	if (requestOrigin) {
		const isLocalhost = localhostPrefixes.some((prefix) =>
			requestOrigin.startsWith(prefix),
		);
		if (isLocalhost || (ALLOWED_ORIGIN && requestOrigin === ALLOWED_ORIGIN)) {
			return requestOrigin;
		}
	}

	return ALLOWED_ORIGIN ?? "*";
}

export function applyCorsHeaders(request: Request, response: Response) {
	const origin = resolveAllowedOrigin(request);
	response.headers.set("Access-Control-Allow-Origin", origin);
	response.headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");

	const requestHeaders =
		request.headers.get("access-control-request-headers") ??
		"Content-Type,Authorization,X-Requested-With";
	response.headers.set("Access-Control-Allow-Headers", requestHeaders);
	response.headers.set("Access-Control-Max-Age", "86400");
	response.headers.append("Vary", "Origin");

	return response;
}

export function createCorsPreflightResponse(request: Request) {
	const response = new Response(null, { status: 204 });
	return applyCorsHeaders(request, response);
}
