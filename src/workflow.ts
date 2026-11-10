import { createHash } from "node:crypto";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { preparedSchema, requestSchema, resultSchema } from "./schema.ts";
import type { PreparedSnapshots, RefreshResult, Snapshot } from "./schema.ts";

function hasDuplicateIds(documents: Snapshot["documents"]): boolean {
  return new Set(documents.map(({ id }) => id)).size !== documents.length;
}

function publicFingerprints(documents: Snapshot["documents"]) {
  return documents
    .filter(({ visibility }) => visibility === "public")
    .map(({ id, text }) => ({
      id,
      digest: createHash("sha256").update(text, "utf8").digest("hex"),
    }));
}

const prepareSnapshots = createStep({
  id: "prepare-snapshots",
  inputSchema: requestSchema,
  outputSchema: preparedSchema,
  execute: async ({ inputData }): Promise<PreparedSnapshots> => {
    const { indexed, source, expectedIndexedRevision, expectedSourceRevision, maxChanges } = inputData;

    if (indexed.sourceId !== source.sourceId) {
      return { status: "blocked", reason: "source_mismatch" };
    }
    if (indexed.revision !== expectedIndexedRevision) {
      return { status: "blocked", reason: "indexed_revision_mismatch" };
    }
    if (source.revision !== expectedSourceRevision) {
      return { status: "blocked", reason: "source_revision_mismatch" };
    }
    if (source.revision < indexed.revision) {
      return { status: "blocked", reason: "source_revision_behind" };
    }
    if (hasDuplicateIds(indexed.documents)) {
      return { status: "blocked", reason: "duplicate_indexed_ids" };
    }
    if (hasDuplicateIds(source.documents)) {
      return { status: "blocked", reason: "duplicate_source_ids" };
    }

    return {
      status: "prepared",
      sourceId: source.sourceId,
      indexedRevision: indexed.revision,
      sourceRevision: source.revision,
      indexedPublic: publicFingerprints(indexed.documents),
      sourcePublic: publicFingerprints(source.documents),
      maxChanges,
    };
  },
});

const planOperations = createStep({
  id: "plan-operations",
  inputSchema: preparedSchema,
  outputSchema: resultSchema,
  execute: async ({ inputData }): Promise<RefreshResult> => {
    if (inputData.status === "blocked") return inputData;

    const { sourceId, indexedRevision, sourceRevision, indexedPublic, sourcePublic, maxChanges } = inputData;
    const indexed = new Map(indexedPublic.map(({ id, digest }) => [id, digest]));
    const desired = new Map(sourcePublic.map(({ id, digest }) => [id, digest]));
    const allPublicIds = [...new Set([...indexed.keys(), ...desired.keys()])].sort();
    const removed: string[] = [];
    const upsert: string[] = [];
    const unchanged: string[] = [];

    for (const id of allPublicIds) {
      if (!desired.has(id)) {
        removed.push(id);
      } else if (desired.get(id) !== indexed.get(id)) {
        upsert.push(id);
      } else {
        unchanged.push(id);
      }
    }

    const changeCount = removed.length + upsert.length;
    if (changeCount > 0 && indexedRevision === sourceRevision) {
      return { status: "blocked", reason: "revision_reused" };
    }
    if (changeCount > maxChanges) {
      return { status: "blocked", reason: "change_budget_exceeded", proposedChanges: changeCount, maxChanges };
    }

    return {
      status: "planned",
      sourceId,
      indexedRevision,
      sourceRevision,
      delete: removed,
      upsert,
      unchanged,
      changeCount,
    };
  },
});

export const indexRefresh = createWorkflow({
  id: "public-index-refresh",
  inputSchema: requestSchema,
  outputSchema: resultSchema,
})
  .then(prepareSnapshots)
  .then(planOperations)
  .commit();
