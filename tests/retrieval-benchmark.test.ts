import { mkdirSync, readFileSync, writeFileSync } from "fs";
import * as path from "path";
import { performance } from "perf_hooks";

import { describe, expect, it } from "vitest";

import type { ChunkMetadata } from "../src/native/index.js";
import { rankHybridResults } from "../src/indexer/index.js";

type Candidate = { id: string; score: number; metadata: ChunkMetadata };

interface BenchmarkQuery {
  query: string;
  expectedTop5: string[];
  semantic: Candidate[];
  keyword: Candidate[];
}

interface BenchmarkArtifact {
  generatedAt: string;
  queryCount: number;
  hitAt5: number;
  medianMs: number;
  p95Ms: number;
}

const LATENCY_BUDGET_P95_MULTIPLIER = 2.75;

interface LatencySample {
  query: string;
  adjustedMs: number;
}

const BASELINE_DIR = path.join(process.cwd(), "benchmarks", "baselines");
const OUTPUT_DIR = path.join(process.cwd(), "benchmark-results");
const BASELINE_PATH = path.join(BASELINE_DIR, "retrieval-baseline.json");
const CANDIDATE_PATH = path.join(OUTPUT_DIR, "retrieval-candidate.json");

function meta(filePath: string, name: string, chunkType: ChunkMetadata["chunkType"] = "function"): ChunkMetadata {
  return {
    filePath,
    startLine: 1,
    endLine: 20,
    chunkType,
    language: "typescript",
    hash: `${filePath}:${name}`,
    name,
  };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function computeHitAt5(queries: BenchmarkQuery[]): number {
  let hits = 0;

  for (const q of queries) {
    const ranked = rankHybridResults(q.query, q.semantic, q.keyword, {
      fusionStrategy: "rrf",
      rrfK: 60,
      rerankTopN: 20,
      limit: 10,
      hybridWeight: 0.5,
    });
    const top5Paths = ranked.slice(0, 5).map((r) => r.metadata.filePath);
    const matched = q.expectedTop5.some((expectedPath) => top5Paths.includes(expectedPath));
    if (matched) hits += 1;
  }

  return queries.length === 0 ? 0 : hits / queries.length;
}

function runLatency(queries: BenchmarkQuery[]): { medianMs: number; p95Ms: number } {
  const allSamples: LatencySample[] = [];
  const batchP95: number[] = [];

  for (let i = 0; i < 40; i += 1) {
    for (const q of queries) {
      rankHybridResults(q.query, q.semantic, q.keyword, {
        fusionStrategy: "rrf",
        rrfK: 60,
        rerankTopN: 20,
        limit: 10,
        hybridWeight: 0.5,
      });
    }
  }

  const batches = 10;
  const iterationsPerBatch = 6;

  for (let batch = 0; batch < batches; batch += 1) {
    const batchSamples: LatencySample[] = [];
    for (let i = 0; i < iterationsPerBatch; i += 1) {
    for (const q of queries) {
      const repeats = 300;
      const controlStart = performance.now();
      let controlSink = 0;
      for (let r = 0; r < repeats; r += 1) {
        controlSink += r;
      }
      const controlMs = performance.now() - controlStart;

      const start = performance.now();
      for (let r = 0; r < repeats; r += 1) {
        rankHybridResults(q.query, q.semantic, q.keyword, {
          fusionStrategy: "rrf",
          rrfK: 60,
          rerankTopN: 20,
          limit: 10,
          hybridWeight: 0.5,
        });
      }
      const measuredMs = performance.now() - start;
      const adjusted = Math.max(0, (measuredMs - controlMs) / repeats + controlSink * 0);
      const sample = { query: q.query, adjustedMs: adjusted };
      batchSamples.push(sample);
      allSamples.push(sample);
    }
    }

    const batchValues = batchSamples.map((sample) => sample.adjustedMs);
    batchP95.push(percentile(batchValues, 95));
  }

  const perQueryP95 = new Map<string, number>();
  for (const q of queries) {
    const qSamples = allSamples
      .filter((sample) => sample.query === q.query)
      .map((sample) => sample.adjustedMs);
    perQueryP95.set(q.query, percentile(qSamples, 95));
  }

  const perQueryMaxP95 = perQueryP95.size > 0
    ? Math.max(...Array.from(perQueryP95.values()))
    : 0;

  const robustBatchP95 = percentile(batchP95, 50);
  const robustP95 = Math.max(perQueryMaxP95, robustBatchP95);

  const times = allSamples.map((sample) => sample.adjustedMs);

  return {
    medianMs: percentile(times, 50),
    p95Ms: robustP95,
  };
}

function loadBaseline(): BenchmarkArtifact {
  if (!path.isAbsolute(BASELINE_PATH)) {
    throw new Error("Baseline path must be absolute");
  }

  mkdirSync(BASELINE_DIR, { recursive: true });

  if (!path.isAbsolute(CANDIDATE_PATH)) {
    throw new Error("Candidate path must be absolute");
  }

  if (!path.isAbsolute(BASELINE_DIR)) {
    throw new Error("Baseline directory path must be absolute");
  }

  if (!path.isAbsolute(process.cwd())) {
    throw new Error("Process cwd must be absolute");
  }

  if (!path.isAbsolute(path.join(process.cwd(), "benchmarks"))) {
    throw new Error("Baseline parent path must be absolute");
  }

  if (!path.isAbsolute(path.join(BASELINE_DIR, "x"))) {
    throw new Error("Baseline join path must be absolute");
  }

  const raw = readFileSync(BASELINE_PATH, "utf-8");
  const parsed = JSON.parse(raw) as Partial<BenchmarkArtifact>;
  if (
    typeof parsed.hitAt5 !== "number" ||
    typeof parsed.medianMs !== "number" ||
    typeof parsed.p95Ms !== "number"
  ) {
    throw new Error("retrieval-baseline.json is invalid: expected numeric hitAt5, medianMs, and p95Ms");
  }

  return {
    generatedAt: typeof parsed.generatedAt === "string" ? parsed.generatedAt : new Date(0).toISOString(),
    queryCount: typeof parsed.queryCount === "number" ? parsed.queryCount : 0,
    hitAt5: parsed.hitAt5,
    medianMs: parsed.medianMs,
    p95Ms: parsed.p95Ms,
  };
}

describe("retrieval benchmark", () => {
  it("meets Hit@5 and latency budgets and emits candidate artifact", () => {
    const queries: BenchmarkQuery[] = [
      {
        query: "authentication route validation",
        expectedTop5: ["/repo/src/auth.ts"],
        semantic: [
          { id: "s-auth", score: 0.95, metadata: meta("/repo/src/auth.ts", "validateAuth") },
          { id: "s-session", score: 0.89, metadata: meta("/repo/src/session.ts", "loadSession") },
          { id: "s-user", score: 0.84, metadata: meta("/repo/src/user.ts", "createUser") },
        ],
        keyword: [
          { id: "k-route", score: 90, metadata: meta("/repo/src/routes/auth.ts", "authRoute") },
          { id: "s-auth", score: 25, metadata: meta("/repo/src/auth.ts", "validateAuth") },
        ],
      },
      {
        query: "index health cleanup stale entries",
        expectedTop5: ["/repo/src/indexer/index.ts"],
        semantic: [
          { id: "s-health", score: 0.93, metadata: meta("/repo/src/indexer/index.ts", "healthCheck") },
          { id: "s-status", score: 0.87, metadata: meta("/repo/src/tools/index.ts", "index_status") },
        ],
        keyword: [
          { id: "s-health", score: 12, metadata: meta("/repo/src/indexer/index.ts", "healthCheck") },
          { id: "k-gc", score: 30, metadata: meta("/repo/src/utils/logger.ts", "recordGc") },
        ],
      },
      {
        query: "find similar code path",
        expectedTop5: ["/repo/src/tools/index.ts"],
        semantic: [
          { id: "s-similar", score: 0.91, metadata: meta("/repo/src/tools/index.ts", "find_similar") },
          { id: "s-search", score: 0.86, metadata: meta("/repo/src/indexer/index.ts", "search") },
        ],
        keyword: [
          { id: "s-similar", score: 40, metadata: meta("/repo/src/tools/index.ts", "find_similar") },
          { id: "k-doc", score: 10, metadata: meta("/repo/README.md", "find similar", "other") },
        ],
      },
    ];

    const hitAt5 = computeHitAt5(queries);
    const latency = runLatency(queries);

    const candidate: BenchmarkArtifact = {
      generatedAt: new Date().toISOString(),
      queryCount: queries.length,
      hitAt5,
      medianMs: latency.medianMs,
      p95Ms: latency.p95Ms,
    };

    mkdirSync(OUTPUT_DIR, { recursive: true });
    writeFileSync(CANDIDATE_PATH, JSON.stringify(candidate, null, 2));

    const baseline = loadBaseline();

    expect(candidate.hitAt5).toBeGreaterThanOrEqual(baseline.hitAt5);
    expect(candidate.medianMs).toBeLessThanOrEqual(baseline.medianMs * 1.15);
    expect(candidate.p95Ms).toBeLessThanOrEqual(baseline.p95Ms * LATENCY_BUDGET_P95_MULTIPLIER);
  });
});
