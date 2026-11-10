import { readFile } from "node:fs/promises";
import { requestSchema } from "./schema.ts";

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args.includes("--help") || args.includes("-h")) {
    const usage = "Usage: npm run --silent plan -- <snapshot-pair.json>";
    if (args.length === 1) {
      console.log(usage);
      return 0;
    }
    console.error(usage);
    return 2;
  }

  let input: unknown;
  try {
    input = JSON.parse(await readFile(args[0], "utf8"));
  } catch {
    console.error("Could not read the snapshot pair as JSON.");
    return 2;
  }

  const request = requestSchema.safeParse(input);
  if (!request.success) {
    for (const issue of request.error.issues) {
      console.error(`${issue.path.join(".") || "input"}: ${issue.code}`);
    }
    return 2;
  }

  process.env.MASTRA_TELEMETRY_DISABLED = "1";
  try {
    const { indexRefresh } = await import("./workflow.ts");
    const run = await indexRefresh.createRun();
    const result = await run.start({ inputData: request.data });
    if (result.status === "success") {
      console.log(JSON.stringify(result.result, null, 2));
      return result.result.status === "planned" ? 0 : 1;
    }
  } catch {
    // Keep framework errors and request data out of the report.
  }
  console.error("The workflow did not produce a refresh plan.");
  return 2;
}

process.exitCode = await main();
