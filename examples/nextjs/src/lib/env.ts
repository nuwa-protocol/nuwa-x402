import { z } from "zod";

const envSchema = z.object({
	SERVICE_PRIVATE_KEY: z
		.string()
		.regex(
			/^0x[0-9a-fA-F]{64}$/,
			"SERVICE_PRIVATE_KEY must be a 32-byte 0x-prefixed hex string",
		),
	NETWORK: z.enum(["base", "base-sepolia"]).default("base-sepolia"),
	ALLOWED_ORIGIN: z.string().url().optional(),
	OPENROUTER_API_KEY: z.string().min(1),
});

type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | null = null;

function parseEnv(): Env {
	const result = envSchema.safeParse({
		SERVICE_PRIVATE_KEY: process.env.SERVICE_PRIVATE_KEY,
		NETWORK: process.env.NETWORK,
		ALLOWED_ORIGIN: process.env.ALLOWED_ORIGIN,
		OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
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
