import { z } from "zod";

const idSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const revisionSchema = z.int().nonnegative();

const documentSchema = z.strictObject({
  id: idSchema,
  visibility: z.enum(["public", "private"]),
  text: z.string(),
});

const snapshotSchema = z.strictObject({
  sourceId: idSchema,
  revision: revisionSchema,
  complete: z.literal(true),
  documents: z.array(documentSchema),
});

export const requestSchema = z.strictObject({
  indexed: snapshotSchema,
  source: snapshotSchema,
  expectedIndexedRevision: revisionSchema,
  expectedSourceRevision: revisionSchema,
  maxChanges: z.int().nonnegative(),
});

export type RefreshRequest = z.infer<typeof requestSchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;

const blockedSchema = z.strictObject({
  status: z.literal("blocked"),
  reason: z.enum([
    "source_mismatch",
    "indexed_revision_mismatch",
    "source_revision_mismatch",
    "source_revision_behind",
    "duplicate_indexed_ids",
    "duplicate_source_ids",
    "revision_reused",
    "change_budget_exceeded",
  ]),
  proposedChanges: z.int().nonnegative().optional(),
  maxChanges: z.int().nonnegative().optional(),
});

const publicDocumentSchema = z.strictObject({
  id: idSchema,
  digest: z.string(),
});

const planContextSchema = z.strictObject({
  sourceId: idSchema,
  indexedRevision: revisionSchema,
  sourceRevision: revisionSchema,
});

export const preparedSchema = z.discriminatedUnion("status", [
  blockedSchema,
  planContextSchema.extend({
    status: z.literal("prepared"),
    indexedPublic: z.array(publicDocumentSchema),
    sourcePublic: z.array(publicDocumentSchema),
    maxChanges: z.int().nonnegative(),
  }),
]);

export const resultSchema = z.discriminatedUnion("status", [
  blockedSchema,
  planContextSchema.extend({
    status: z.literal("planned"),
    delete: z.array(idSchema),
    upsert: z.array(idSchema),
    unchanged: z.array(idSchema),
    changeCount: z.int().nonnegative(),
  }),
]);

export type PreparedSnapshots = z.infer<typeof preparedSchema>;
export type RefreshResult = z.infer<typeof resultSchema>;
