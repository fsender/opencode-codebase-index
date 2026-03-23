import { describe, expect, it } from "vitest";

import { parseBudget, parseGoldenDataset } from "../src/eval/schema.js";

describe("eval schema", () => {
  it("parses a valid dataset", () => {
    const dataset = parseGoldenDataset(
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
      "dataset.json"
    );

    expect(dataset.name).toBe("small");
    expect(dataset.queries).toHaveLength(1);
  });

  it("rejects dataset with missing expected path", () => {
    expect(() =>
      parseGoldenDataset(
        {
          version: "1.0.0",
          name: "small",
          queries: [
            {
              id: "q1",
              query: "where",
              queryType: "definition",
              expected: {},
            },
          ],
        },
        "dataset.json"
      )
    ).toThrow(/expected.filePath or expected.acceptableFiles/);
  });

  it("rejects duplicate query ids", () => {
    expect(() =>
      parseGoldenDataset(
        {
          version: "1.0.0",
          name: "small",
          queries: [
            {
              id: "q1",
              query: "a",
              queryType: "definition",
              expected: { filePath: "a.ts" },
            },
            {
              id: "q1",
              query: "b",
              queryType: "definition",
              expected: { filePath: "b.ts" },
            },
          ],
        },
        "dataset.json"
      )
    ).toThrow(/duplicate id/);
  });

  it("parses budget and validates threshold types", () => {
    const budget = parseBudget(
      {
        name: "default",
        baselinePath: "benchmarks/baselines/eval-baseline-summary.json",
        failOnMissingBaseline: true,
        thresholds: {
          hitAt5MaxDrop: 0.05,
          mrrAt10MaxDrop: 0.02,
          p95LatencyMaxMultiplier: 1.5,
        },
      },
      "budget.json"
    );

    expect(budget.thresholds.hitAt5MaxDrop).toBe(0.05);
    expect(budget.failOnMissingBaseline).toBe(true);
  });

  it("rejects invalid threshold types", () => {
    expect(() =>
      parseBudget(
        {
          name: "default",
          thresholds: {
            hitAt5MaxDrop: "bad",
          },
        },
        "budget.json"
      )
    ).toThrow(/must be a non-negative number/);
  });
});
