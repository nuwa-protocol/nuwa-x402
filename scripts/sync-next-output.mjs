import fs from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();
const source = path.join(repoRoot, "examples", "nextjs", ".next");
const target = path.join(repoRoot, ".next");

async function main() {
  try {
    await fs.access(source);
  } catch (error) {
    console.error(
      `Next.js build output missing at ${source}. Has examples/nextjs been built?`,
    );
    process.exit(1);
  }

  await fs.rm(target, { recursive: true, force: true });
  await fs.cp(source, target, { recursive: true });

  console.log(
    `Synced Next.js build output from ${source} to ${target} for Vercel runtime.`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

