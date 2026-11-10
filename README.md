# Mastra Index Refresh

Preview what a public vector index needs to delete, upsert, and leave unchanged when its knowledge source changes. This offline example runs two typed [Mastra workflow steps](https://mastra.ai/docs/workflows/control-flow) over a pair of synthetic snapshots and returns a deterministic JSON plan. It makes no index writes.

## Run it

Use Node.js 22.13 or newer. Install the locked dependencies once, then run the planner and tests locally.

```sh
npm ci --ignore-scripts
npm run --silent plan -- fixtures/support-source.json
npm run check
npm test
```

The fixture plans two deletions, three upserts and one unchanged public document. A notice that became private is among the deletions. A private draft that became public is among the upserts. Documents private in both snapshots stay out of the plan.

The CLI returns **0** for a plan, **1** for a blocked plan and **2** for invalid input or a workflow error. A blocked plan contains the reason and, when the budget was exceeded, the proposed operation count. Document text and fingerprints stay out of standard output.

## What the workflow checks

1. **Prepare snapshots.** Both snapshots must be complete and describe the same source. Their revisions must match the expected revisions and the desired revision must be at least as recent as the indexed revision. Duplicate IDs block the plan, including duplicates among private documents. The step fingerprints public text and sends only public IDs and fingerprints to the comparison step.
2. **Plan operations.** Compare the public documents in sorted ID order. Delete an indexed document that was removed or made private. Upsert a new, changed or newly public document. Reject public changes under a reused revision. Block the entire plan if deletes plus upserts exceed `maxChanges`.

In the fixture, `indexed` describes the source revision used for the last successful refresh, and `source` describes the desired revision. `expectedIndexedRevision` and `expectedSourceRevision` are the revisions your caller expects to compare. A `complete: true` flag is a caller assertion that absence from a snapshot is meaningful. Pass full snapshots and derive expected revisions from your source and index metadata.

## Coverage limits

This example plans document-level operations for one public index. It does not fetch documents, embed text, call a vector database, enforce permissions in a private index, or apply changes. The plan compares exact UTF-8 text. Changes to chunking, embedding models, or indexed metadata need a separate refresh strategy.

To apply a plan, recheck the source revision, visibility, and indexed revision at write time. Upsert means replacing all chunks for the document, including removing chunks left over from an earlier version. Delete means removing every indexed chunk for the document. A blocked plan requires an explicit decision before writes. If visibility has been revoked, apply your system's access controls immediately while index cleanup is pending.

The report omits document text, but the snapshots themselves contain it. Use synthetic fixtures and account for input retention and logging before adapting the workflow to real data. The tests run the actual Mastra workflow with fetch and socket connections blocked.

For more on retrieval quality, source updates and access boundaries, see [Fnctn's RAG and knowledge systems service](https://fnctn.io/services/rag-knowledge-systems/).

## License

MIT · Fnctn Inc.
