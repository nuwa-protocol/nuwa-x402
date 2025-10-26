import type { NextRequest } from "next/server";
import { createCorsPreflightResponse } from "@/lib/cors";
import { forwardOpenRouter } from "./proxy-handler";

export const runtime = "nodejs";

export function OPTIONS(request: NextRequest) {
	return createCorsPreflightResponse(request);
}

export function GET(request: NextRequest) {
	return forwardOpenRouter(request);
}

export function POST(request: NextRequest) {
	return forwardOpenRouter(request);
}
