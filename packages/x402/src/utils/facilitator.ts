/**
 * Normalizes a facilitator configuration by removing trailing slashes from the URL.
 * This ensures consistent URL handling across the codebase.
 */
export function normalizeFacilitatorUrl<T extends { url: string }>(
	facilitator: T | undefined,
): T | undefined {
	if (!facilitator) return undefined;
	return {
		...facilitator,
		url: facilitator.url.replace(/\/$/, "") as T["url"],
	};
}
