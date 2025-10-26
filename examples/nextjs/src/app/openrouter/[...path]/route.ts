import type { NextRequest } from "next/server";
import { createCorsPreflightResponse } from "@/lib/cors";
import { forwardOpenRouter } from "../proxy-handler";

type RouteContext = {
	params: Promise<{
		path?: string[];
	}>;
};

export const runtime = "nodejs";

export function OPTIONS(request: NextRequest) {
	return createCorsPreflightResponse(request);
}

export async function GET(request: NextRequest, context: RouteContext) {
	const params = await context.params;
	return forwardOpenRouter(request, params.path ?? []);
}

export async function POST(request: NextRequest, context: RouteContext) {
	const params = await context.params;
	return forwardOpenRouter(request, params.path ?? []);
}
