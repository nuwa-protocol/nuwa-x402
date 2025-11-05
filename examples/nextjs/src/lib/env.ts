import { z } from "zod";

const facilitatorUrlSchema = z
	.string()
	.regex(
		/^[a-z][a-z0-9+.-]*:\/\/.+$/i,
		"X402_FACILITATOR_URL must include scheme, e.g. https://facilitator.example.com",
	)
	.transform((value) => value as `${string}://${string}`);

const envSchema = z.object({
	SERVICE_PRIVATE_KEY: z
		.string()
		.regex(
			/^0x[0-9a-fA-F]{64}$/,
			"SERVICE_PRIVATE_KEY must be a 32-byte 0x-prefixed hex string",
		),
	// Target chain for payments. Migrated from Base→X Layer
	NETWORK: z
		.enum(["x-layer", "x-layer-testnet", "base", "base-sepolia"]) // keep Base for backward compat
		.default("x-layer-testnet"),
	ALLOWED_ORIGIN: z.string().url().optional(),
	OPENROUTER_API_KEY: z.string().min(1),
	X402_FACILITATOR_URL: facilitatorUrlSchema.optional(),
});

type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | null = null;

function parseEnv(): Env {
	const facilitatorUrl = process.env.X402_FACILITATOR_URL?.trim();

	const result = envSchema.safeParse({
		SERVICE_PRIVATE_KEY: process.env.SERVICE_PRIVATE_KEY,
		NETWORK: process.env.NETWORK,
		ALLOWED_ORIGIN: process.env.ALLOWED_ORIGIN,
		OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
		X402_FACILITATOR_URL: facilitatorUrl ? facilitatorUrl : undefined,
	});

	if (!result.success) {
		const issues = result.error.issues
			.map((issue) => {
				const path = issue.path.join(".") || "(root)";
				return `${path}: ${issue.message}`;
			})
			.join("; ");
		throw new Error(`Invalid environment configuration: ${issues}`);
	}

	return result.data;
}

export function getEnv(): Env {
	if (!cachedEnv) {
		cachedEnv = parseEnv();
	}
	return cachedEnv;
}

export type { Env };
