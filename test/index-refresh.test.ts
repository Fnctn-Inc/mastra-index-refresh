import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { requestSchema } from "../src/schema.ts";
import type { RefreshRequest } from "../src/schema.ts";

const fixturePath = fileURLToPath(new URL("../fixtures/support-source.json", import.meta.url));
const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const fixture = requestSchema.parse(JSON.parse(await readFile(fixturePath, "utf8")));

async function runPlan(inputData: RefreshRequest) {
  const { indexRefresh } = await import("../src/workflow.ts");
  const run = await indexRefresh.createRun();
  const result = await run.start({ inputData });
  assert.equal(result.status, "success");
  return result.result;
}

const expected = {
  status: "planned",
  sourceId: "demo-support",
  indexedRevision: 12,
  sourceRevision: 13,
  delete: ["retired-faq", "temporary-notice"],
  upsert: ["prelaunch-guide", "reset-guide", "setup-guide"],
  unchanged: ["contact-options"],
  changeCount: 5,
};

test("real workflow plans the fixture with network access blocked", async (t) => {
  const failNetwork = () => { throw new Error("unexpected network use"); };
  const connect = t.mock.method(Socket.prototype, "connect", failNetwork);
  const fetch = t.mock.method(globalThis, "fetch", failNetwork);
  const plan = await runPlan(fixture);
  assert.deepEqual(plan, expected);
  assert.equal(connect.mock.callCount(), 0);
  assert.equal(fetch.mock.callCount(), 0);
  assert.doesNotMatch(JSON.stringify(plan), /internal-checklist|Synthetic|wizard|digest|text/);
});

test("shuffled snapshots return the same plan", async () => {
  const input = structuredClone(fixture);
  input.indexed.documents.reverse();
  input.source.documents.reverse();
  assert.deepEqual(await runPlan(input), expected);
});

test("a zero-change repeat returns only unchanged public documents", async () => {
  const input = structuredClone(fixture);
  input.indexed = structuredClone(input.source);
  input.expectedIndexedRevision = input.source.revision;
  input.maxChanges = 0;
  assert.deepEqual(await runPlan(input), {
    status: "planned",
    sourceId: "demo-support",
    indexedRevision: 13,
    sourceRevision: 13,
    delete: [],
    upsert: [],
    unchanged: ["contact-options", "prelaunch-guide", "reset-guide", "setup-guide"],
    changeCount: 0,
  });
});

test("blocks a stale source or indexed revision and a source mismatch", async () => {
  assert.deepEqual(await runPlan({ ...fixture, expectedSourceRevision: 14 }),
    { status: "blocked", reason: "source_revision_mismatch" });
  assert.deepEqual(await runPlan({ ...fixture, expectedIndexedRevision: 11 }),
    { status: "blocked", reason: "indexed_revision_mismatch" });
  assert.deepEqual(await runPlan({ ...fixture, source: { ...fixture.source, sourceId: "other-source" } }),
    { status: "blocked", reason: "source_mismatch" });
});

test("blocks backwards or reused revisions", async () => {
  assert.deepEqual(await runPlan({
    ...fixture, source: { ...fixture.source, revision: 11 }, expectedSourceRevision: 11,
  }), { status: "blocked", reason: "source_revision_behind" });
  assert.deepEqual(await runPlan({
    ...fixture, source: { ...fixture.source, revision: 12 }, expectedSourceRevision: 12,
  }), { status: "blocked", reason: "revision_reused" });
});

test("rejects duplicate IDs before filtering private documents", async () => {
  const indexed = structuredClone(fixture.indexed);
  indexed.documents.push({ ...indexed.documents[0], visibility: "private" });
  assert.deepEqual(await runPlan({ ...fixture, indexed }),
    { status: "blocked", reason: "duplicate_indexed_ids" });

  const source = structuredClone(fixture.source);
  const privateDoc = source.documents.find(({ visibility }) => visibility === "private")!;
  source.documents.push({ ...privateDoc });
  assert.deepEqual(await runPlan({ ...fixture, source }),
    { status: "blocked", reason: "duplicate_source_ids" });
});

test("an exceeded budget returns counts without a partial plan", async () => {
  assert.deepEqual(await runPlan({ ...fixture, maxChanges: 4 }), {
    status: "blocked",
    reason: "change_budget_exceeded",
    proposedChanges: 5,
    maxChanges: 4,
  });
});

test("CLI prints stable JSON and uses distinct blocked and invalid exits", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "mastra-index-refresh-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const command = (inputPath: string) => spawnSync(process.execPath, [
    "--no-warnings=ExperimentalWarning", "--experimental-strip-types", cliPath, inputPath,
  ], { encoding: "utf8", timeout: 15_000 });

  const good = command(fixturePath);
  assert.equal(good.status, 0, good.stderr);
  assert.deepEqual(JSON.parse(good.stdout), expected);
  assert.equal(command(fixturePath).stdout, good.stdout);

  const blockedPath = join(temp, "blocked.json");
  await writeFile(blockedPath, JSON.stringify({ ...fixture, maxChanges: 0 }));
  const blocked = command(blockedPath);
  assert.equal(blocked.status, 1, blocked.stderr);
  assert.equal(JSON.parse(blocked.stdout).reason, "change_budget_exceeded");

  const partialPath = join(temp, "partial.json");
  await writeFile(partialPath, JSON.stringify({
    ...fixture, source: { ...fixture.source, complete: false },
  }));
  const invalid = command(partialPath);
  assert.equal(invalid.status, 2);
  assert.equal(invalid.stdout, "");
  assert.match(invalid.stderr, /source\.complete/);
  assert.doesNotMatch(invalid.stderr, /Synthetic|wizard/);
});
