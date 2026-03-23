import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runEvaluation, runSweep } from "../src/eval/runner.js";

describe("eval runner", () => {
  let tempDir: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      const texts = Array.isArray(body.input) ? body.input : [];

      const data = texts.map((text) => {
        let seed = 0;
        for (const ch of text) {
          seed = (seed * 31 + ch.charCodeAt(0)) % 1000;
        }
        return {
          embedding: Array.from({ length: 8 }, (_, idx) => ((seed + idx * 17) % 997) / 997),
        };
      });

      return new Response(
        JSON.stringify({
          data,
          usage: { total_tokens: Math.max(1, texts.length * 8) },
        }),
        { status: 200 }
      );
    });

    tempDir = mkdtempSync(path.join(os.tmpdir(), "eval-runner-"));
    mkdirSync(path.join(tempDir, "src", "indexer"), { recursive: true });
    mkdirSync(path.join(tempDir, "src", "tools"), { recursive: true });
    mkdirSync(path.join(tempDir, ".opencode"), { recursive: true });
    mkdirSync(path.join(tempDir, "benchmarks", "golden"), { recursive: true });
    mkdirSync(path.join(tempDir, "benchmarks", "budgets"), { recursive: true });
    mkdirSync(path.join(tempDir, "benchmarks", "baselines"), { recursive: true });

    writeFileSync(
      path.join(tempDir, ".opencode", "codebase-index.json"),
      JSON.stringify(
        {
          embeddingProvider: "custom",
          customProvider: {
            baseUrl: "http://localhost:11434/v1",
            model: "mock-embedding-model",
            dimensions: 8,
          },
          indexing: {
            watchFiles: false,
          },
          search: {
            maxResults: 10,
            minScore: 0,
            fusionStrategy: "rrf",
            rrfK: 60,
            rerankTopN: 20,
          },
        },
        null,
        2
      ),
      "utf-8"
    );

    writeFileSync(
      path.join(tempDir, "src", "indexer", "index.ts"),
      "export function rankHybridResults(query: string) { return query.length; }\n",
      "utf-8"
    );
    writeFileSync(
      path.join(tempDir, "src", "tools", "index.ts"),
      "export const codebase_search = () => 'ok';\n",
      "utf-8"
    );

    writeFileSync(
      path.join(tempDir, "benchmarks", "golden", "small.json"),
      JSON.stringify(
        {
          version: "1.0.0",
          name: "small",
          queries: [
            {
              id: "q1",
              query: "where is rankHybridResults implementation",
              queryType: "definition",
              expected: {
                filePath: "src/indexer/index.ts",
                symbol: "rankHybridResults",
              },
            },
          ],
        },
        null,
        2
      ),
      "utf-8"
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("runs eval and writes required artifacts", async () => {
    const result = await runEvaluation({
      projectRoot: tempDir,
      datasetPath: "benchmarks/golden/small.json",
      outputRoot: "benchmarks/results",
      ciMode: false,
      reindex: false,
    });

    expect(result.summary.queryCount).toBe(1);
    expect(readFileSync(path.join(result.outputDir, "summary.json"), "utf-8")).toContain("\"metrics\"");
    expect(readFileSync(path.join(result.outputDir, "summary.md"), "utf-8")).toContain("# Evaluation Summary");
    expect(readFileSync(path.join(result.outputDir, "per-query.json"), "utf-8")).toContain("\"queries\"");
  });

  it("compares against baseline and writes compare artifact", async () => {
    const baselineRun = await runEvaluation({
      projectRoot: tempDir,
      datasetPath: "benchmarks/golden/small.json",
      outputRoot: "benchmarks/results",
      ciMode: false,
      reindex: false,
    });

    const baselinePath = path.join(tempDir, "benchmarks", "baselines", "eval-baseline-summary.json");
    writeFileSync(
      baselinePath,
      JSON.stringify(baselineRun.summary, null, 2),
      "utf-8"
    );

    const compareRun = await runEvaluation({
      projectRoot: tempDir,
      datasetPath: "benchmarks/golden/small.json",
      outputRoot: "benchmarks/results",
      againstPath: "benchmarks/baselines/eval-baseline-summary.json",
      ciMode: false,
      reindex: false,
    });

    expect(compareRun.comparison).toBeDefined();
    expect(readFileSync(path.join(compareRun.outputDir, "compare.json"), "utf-8")).toContain("\"deltas\"");
  });

  it("fails ci gate when thresholds regress beyond tolerance", async () => {
    const baselineRun = await runEvaluation({
      projectRoot: tempDir,
      datasetPath: "benchmarks/golden/small.json",
      outputRoot: "benchmarks/results",
      ciMode: false,
      reindex: false,
    });

    const baselinePath = path.join(tempDir, "benchmarks", "baselines", "eval-baseline-summary.json");
    writeFileSync(
      baselinePath,
      JSON.stringify(
        {
          ...baselineRun.summary,
          metrics: {
            ...baselineRun.summary.metrics,
            hitAt5: 0.95,
            mrrAt10: 0.95,
            latencyMs: {
              p50: 1,
              p95: 1,
              p99: 1,
            },
          },
        },
        null,
        2
      ),
      "utf-8"
    );

    writeFileSync(
      path.join(tempDir, "benchmarks", "budgets", "default.json"),
      JSON.stringify(
        {
          name: "default",
          baselinePath: "benchmarks/baselines/eval-baseline-summary.json",
          failOnMissingBaseline: true,
          thresholds: {
            hitAt5MaxDrop: 0.01,
            mrrAt10MaxDrop: 0.01,
            p95LatencyMaxMultiplier: 1.01,
            minHitAt5: 1.1,
          },
        },
        null,
        2
      ),
      "utf-8"
    );

    const run = await runEvaluation({
      projectRoot: tempDir,
      datasetPath: "benchmarks/golden/small.json",
      outputRoot: "benchmarks/results",
      ciMode: true,
      budgetPath: "benchmarks/budgets/default.json",
      reindex: false,
    });

    expect(run.gate?.passed).toBe(false);
    expect((run.gate?.violations.length ?? 0) > 0).toBe(true);
  });

  it("runs parameter sweep and emits aggregate compare report", async () => {
    const sweep = await runSweep(
      {
        projectRoot: tempDir,
        datasetPath: "benchmarks/golden/small.json",
        outputRoot: "benchmarks/results",
        ciMode: false,
        reindex: false,
      },
      {
        fusionStrategy: ["rrf", "weighted"],
        hybridWeight: [0.4, 0.6],
        rrfK: [30],
        rerankTopN: [10],
      }
    );

    expect(sweep.aggregate.runCount).toBe(4);
    expect(readFileSync(path.join(sweep.outputDir, "compare.json"), "utf-8")).toContain("\"runCount\"");
  });
});
