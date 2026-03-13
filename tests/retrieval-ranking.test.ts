import { describe, expect, it } from "vitest";

import type { ChunkMetadata } from "../src/native/index.js";
import {
  fuseResultsRrf,
  fuseResultsWeighted,
  rerankResults,
  rankHybridResults,
  rankSemanticOnlyResults,
} from "../src/indexer/index.js";

type Candidate = { id: string; score: number; metadata: ChunkMetadata };

function meta(overrides: Partial<ChunkMetadata>): ChunkMetadata {
  return {
    filePath: "/repo/src/unknown.ts",
    startLine: 1,
    endLine: 10,
    chunkType: "other",
    language: "typescript",
    hash: "hash",
    ...overrides,
  };
}

describe("retrieval ranking", () => {
  it("fuses hybrid results using RRF rank ordering", () => {
    const semantic: Candidate[] = [
      { id: "a", score: 0.91, metadata: meta({ filePath: "/repo/src/auth.ts", name: "validateAuth", chunkType: "function" }) },
      { id: "b", score: 0.89, metadata: meta({ filePath: "/repo/src/session.ts", name: "loadSession", chunkType: "function" }) },
      { id: "c", score: 0.88, metadata: meta({ filePath: "/repo/src/cache.ts", name: "readCache", chunkType: "function" }) },
    ];
    const keyword: Candidate[] = [
      { id: "d", score: 50, metadata: meta({ filePath: "/repo/src/auth-route.ts", name: "authRoute", chunkType: "function" }) },
      { id: "c", score: 30, metadata: meta({ filePath: "/repo/src/cache.ts", name: "readCache", chunkType: "function" }) },
      { id: "a", score: 1, metadata: meta({ filePath: "/repo/src/auth.ts", name: "validateAuth", chunkType: "function" }) },
    ];

    const fused = fuseResultsRrf(semantic, keyword, 60, 10);
    expect(fused.map(r => r.id).slice(0, 3)).toEqual(["a", "c", "d"]);
  });

  it("keeps both semantic-only and keyword-only candidates in top fused results", () => {
    const semantic: Candidate[] = [
      { id: "semanticOnly", score: 0.95, metadata: meta({ filePath: "/repo/src/semantic.ts", name: "semanticBest", chunkType: "function" }) },
      { id: "both", score: 0.9, metadata: meta({ filePath: "/repo/src/both.ts", name: "bothCandidate", chunkType: "function" }) },
    ];
    const keyword: Candidate[] = [
      { id: "keywordOnly", score: 100, metadata: meta({ filePath: "/repo/src/keyword.ts", name: "keywordBest", chunkType: "function" }) },
      { id: "both", score: 1, metadata: meta({ filePath: "/repo/src/both.ts", name: "bothCandidate", chunkType: "function" }) },
    ];

    const fused = fuseResultsRrf(semantic, keyword, 60, 5);
    const top3 = fused.map(r => r.id).slice(0, 3);
    expect(top3[0]).toBe("both");
    expect(top3).toContain("semanticOnly");
    expect(top3).toContain("keywordOnly");
  });

  it("reranks deterministically using name/path/chunk-type signals", () => {
    const candidates: Candidate[] = [
      { id: "generic", score: 0.9, metadata: meta({ filePath: "/repo/src/misc.ts", name: "handler", chunkType: "other" }) },
      { id: "pathOverlap", score: 0.9, metadata: meta({ filePath: "/repo/src/auth/handler.ts", name: "handler", chunkType: "other" }) },
      { id: "exactName", score: 0.9, metadata: meta({ filePath: "/repo/src/services/auth.ts", name: "auth", chunkType: "function" }) },
    ];

    const reranked = rerankResults("auth handler", candidates, 10);
    expect(reranked.map(r => r.id)).toEqual(["exactName", "pathOverlap", "generic"]);

    const rerankedAgain = rerankResults("auth handler", candidates, 10);
    expect(rerankedAgain.map(r => r.id)).toEqual(["exactName", "pathOverlap", "generic"]);
  });

  it("applies hybrid ranking path for search and semantic-only rerank for findSimilar", () => {
    const semantic: Candidate[] = [
      { id: "s1", score: 0.95, metadata: meta({ filePath: "/repo/src/auth.ts", name: "auth", chunkType: "function" }) },
      { id: "s2", score: 0.92, metadata: meta({ filePath: "/repo/src/util.ts", name: "helper", chunkType: "function" }) },
    ];
    const keyword: Candidate[] = [
      { id: "k1", score: 42, metadata: meta({ filePath: "/repo/src/routes/auth.ts", name: "authRoute", chunkType: "function" }) },
    ];

    const searchRanked = rankHybridResults("auth", semantic, keyword, {
      fusionStrategy: "rrf",
      rrfK: 60,
      rerankTopN: 5,
      limit: 5,
      hybridWeight: 0.5,
    });
    expect(searchRanked.some(r => r.id === "k1")).toBe(true);

    const similarRanked = rankSemanticOnlyResults("auth", semantic, {
      rerankTopN: 5,
      limit: 5,
    });
    expect(similarRanked.map(r => r.id)).not.toContain("k1");
  });

  it("returns pre-rerank order when rerankTopN is 0", () => {
    const semantic: Candidate[] = [
      { id: "a", score: 0.92, metadata: meta({ filePath: "/repo/src/a.ts", name: "a", chunkType: "function" }) },
      { id: "b", score: 0.90, metadata: meta({ filePath: "/repo/src/b.ts", name: "b", chunkType: "function" }) },
      { id: "c", score: 0.88, metadata: meta({ filePath: "/repo/src/c.ts", name: "c", chunkType: "function" }) },
    ];
    const keyword: Candidate[] = [
      { id: "b", score: 80, metadata: meta({ filePath: "/repo/src/b.ts", name: "b", chunkType: "function" }) },
      { id: "x", score: 79, metadata: meta({ filePath: "/repo/src/x.ts", name: "x", chunkType: "function" }) },
    ];

    const preRerank = fuseResultsRrf(semantic, keyword, 60, 10);
    const ranked = rankHybridResults("query", semantic, keyword, {
      fusionStrategy: "rrf",
      rrfK: 60,
      rerankTopN: 0,
      limit: 10,
      hybridWeight: 0.5,
    });

    expect(ranked.map(r => r.id)).toEqual(preRerank.map(r => r.id));
  });

  it("supports weighted fusion strategy fallback", () => {
    const semantic: Candidate[] = [
      { id: "a", score: 1.0, metadata: meta({ filePath: "/repo/src/a.ts", name: "a", chunkType: "function" }) },
      { id: "b", score: 0.8, metadata: meta({ filePath: "/repo/src/b.ts", name: "b", chunkType: "function" }) },
    ];
    const keyword: Candidate[] = [
      { id: "b", score: 4.0, metadata: meta({ filePath: "/repo/src/b.ts", name: "b", chunkType: "function" }) },
      { id: "c", score: 3.0, metadata: meta({ filePath: "/repo/src/c.ts", name: "c", chunkType: "function" }) },
    ];

    const weighted = fuseResultsWeighted(semantic, keyword, 0.5, 10);
    expect(weighted.map(r => r.id).slice(0, 2)).toEqual(["b", "c"]);
  });

  it("handles edge cases for disjoint and empty candidate sets", () => {
    const semantic: Candidate[] = [
      { id: "s1", score: 0.9, metadata: meta({ filePath: "/repo/src/s1.ts", name: "s1", chunkType: "function" }) },
    ];
    const keyword: Candidate[] = [
      { id: "k1", score: 2.5, metadata: meta({ filePath: "/repo/src/k1.ts", name: "k1", chunkType: "function" }) },
    ];

    const disjoint = fuseResultsRrf(semantic, keyword, 60, 10);
    expect(disjoint).toHaveLength(2);
    expect(disjoint.map(r => r.id)).toContain("s1");
    expect(disjoint.map(r => r.id)).toContain("k1");

    expect(fuseResultsRrf([], [], 60, 10)).toEqual([]);
    expect(rankSemanticOnlyResults("q", [], { rerankTopN: 10, limit: 5 })).toEqual([]);
  });
});
