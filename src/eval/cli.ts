import * as path from "path";

import { compareSummaries } from "./compare.js";
import { createSummaryMarkdown, createRunDirectory, loadSummary, writeJson, writeText } from "./reports.js";
import { runEvaluation, runSweep } from "./runner.js";
import type { EvalRunOptions, SweepDefinition } from "./types.js";

interface ParsedArgs {
  projectRoot: string;
  configPath?: string;
  datasetPath: string;
  currentPath?: string;
  outputRoot: string;
  againstPath?: string;
  budgetPath?: string;
  ciMode: boolean;
  reindex: boolean;
  fusionStrategy?: "rrf" | "weighted";
  hybridWeight?: number;
  rrfK?: number;
  rerankTopN?: number;
  sweep: SweepDefinition;
}

interface EvalSubcommandOptions {
  parsed: ParsedArgs;
  explicitAgainst?: string;
}

function printUsage(): void {
  console.log(`
Usage:
  opencode-codebase-index-mcp eval run [options]
  opencode-codebase-index-mcp eval compare --against <summary.json> [options]
  opencode-codebase-index-mcp eval diff --current <summary.json> --against <summary.json> [options]

Options:
  --project <path>                 Project root (default: cwd)
  --config <path>                  Config JSON path
  --dataset <path>                 Golden dataset path (default: benchmarks/golden/small.json)
  --current <path>                 Current summary.json path (required for eval diff)
  --output <path>                  Output root dir (default: benchmarks/results)
  --against <path>                 Baseline summary.json to compare against
  --budget <path>                  Budget file for CI mode (default: benchmarks/budgets/default.json)
  --ci                             Enable CI gate mode
  --reindex                        Force reindex before eval

Search overrides:
  --fusionStrategy <rrf|weighted>
  --hybridWeight <0-1>
  --rrfK <number>
  --rerankTopN <number>

Sweep options (comma-separated values):
  --sweepFusionStrategy <rrf,weighted>
  --sweepHybridWeight <0.3,0.5,0.7>
  --sweepRrfK <30,60,90>
  --sweepRerankTopN <10,20,40>
`);
}

function parseNumber(value: string, flag: string): number {
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`${flag} must be a number`);
  }
  return parsed;
}

function parseCsvNumbers(value: string, flag: string): number[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => parseNumber(item, flag));
}

function parseCsvFusion(value: string): Array<"rrf" | "weighted"> {
  const values = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  const parsed: Array<"rrf" | "weighted"> = [];
  for (const candidate of values) {
    if (candidate !== "rrf" && candidate !== "weighted") {
      throw new Error("--sweepFusionStrategy accepts only rrf,weighted");
    }
    parsed.push(candidate);
  }
  return parsed;
}

function hasSweepOptions(sweep: SweepDefinition): boolean {
  return Boolean(
    (sweep.fusionStrategy && sweep.fusionStrategy.length > 0) ||
      (sweep.hybridWeight && sweep.hybridWeight.length > 0) ||
      (sweep.rrfK && sweep.rrfK.length > 0) ||
      (sweep.rerankTopN && sweep.rerankTopN.length > 0)
  );
}

function parseEvalArgs(argv: string[], cwd: string): ParsedArgs {
  const parsed: ParsedArgs = {
    projectRoot: cwd,
    datasetPath: "benchmarks/golden/small.json",
    outputRoot: "benchmarks/results",
    budgetPath: "benchmarks/budgets/default.json",
    ciMode: false,
    reindex: false,
    sweep: {},
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--project" && next) {
      parsed.projectRoot = path.resolve(cwd, next);
      i += 1;
      continue;
    }
    if (arg === "--config" && next) {
      parsed.configPath = path.resolve(cwd, next);
      i += 1;
      continue;
    }
    if (arg === "--dataset" && next) {
      parsed.datasetPath = next;
      i += 1;
      continue;
    }
    if (arg === "--current" && next) {
      parsed.currentPath = next;
      i += 1;
      continue;
    }
    if (arg === "--output" && next) {
      parsed.outputRoot = next;
      i += 1;
      continue;
    }
    if (arg === "--against" && next) {
      parsed.againstPath = next;
      i += 1;
      continue;
    }
    if (arg === "--budget" && next) {
      parsed.budgetPath = next;
      i += 1;
      continue;
    }
    if (arg === "--ci") {
      parsed.ciMode = true;
      continue;
    }
    if (arg === "--reindex") {
      parsed.reindex = true;
      continue;
    }
    if (arg === "--fusionStrategy" && next) {
      if (next !== "rrf" && next !== "weighted") {
        throw new Error("--fusionStrategy must be rrf or weighted");
      }
      parsed.fusionStrategy = next;
      i += 1;
      continue;
    }
    if (arg === "--hybridWeight" && next) {
      parsed.hybridWeight = parseNumber(next, "--hybridWeight");
      i += 1;
      continue;
    }
    if (arg === "--rrfK" && next) {
      parsed.rrfK = parseNumber(next, "--rrfK");
      i += 1;
      continue;
    }
    if (arg === "--rerankTopN" && next) {
      parsed.rerankTopN = parseNumber(next, "--rerankTopN");
      i += 1;
      continue;
    }
    if (arg === "--sweepFusionStrategy" && next) {
      parsed.sweep.fusionStrategy = parseCsvFusion(next);
      i += 1;
      continue;
    }
    if (arg === "--sweepHybridWeight" && next) {
      parsed.sweep.hybridWeight = parseCsvNumbers(next, "--sweepHybridWeight");
      i += 1;
      continue;
    }
    if (arg === "--sweepRrfK" && next) {
      parsed.sweep.rrfK = parseCsvNumbers(next, "--sweepRrfK");
      i += 1;
      continue;
    }
    if (arg === "--sweepRerankTopN" && next) {
      parsed.sweep.rerankTopN = parseCsvNumbers(next, "--sweepRerankTopN");
      i += 1;
      continue;
    }
  }

  return parsed;
}

function parseEvalSubcommandOptions(argv: string[], cwd: string): EvalSubcommandOptions {
  let explicitAgainst: string | undefined;
  const filtered: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    const next = argv[i + 1];

    if (current === "--against" && next) {
      explicitAgainst = next;
      i += 1;
      continue;
    }

    filtered.push(current);
  }

  return {
    parsed: parseEvalArgs(filtered, cwd),
    explicitAgainst,
  };
}

function toRunOptions(parsed: ParsedArgs): EvalRunOptions {
  return {
    projectRoot: parsed.projectRoot,
    configPath: parsed.configPath,
    datasetPath: parsed.datasetPath,
    outputRoot: parsed.outputRoot,
    againstPath: parsed.againstPath,
    budgetPath: parsed.budgetPath,
    ciMode: parsed.ciMode,
    reindex: parsed.reindex,
    searchOverrides: {
      ...(parsed.fusionStrategy !== undefined ? { fusionStrategy: parsed.fusionStrategy } : {}),
      ...(parsed.hybridWeight !== undefined ? { hybridWeight: parsed.hybridWeight } : {}),
      ...(parsed.rrfK !== undefined ? { rrfK: parsed.rrfK } : {}),
      ...(parsed.rerankTopN !== undefined ? { rerankTopN: parsed.rerankTopN } : {}),
    },
  };
}

export async function handleEvalCommand(args: string[], cwd: string): Promise<number> {
  const subcommand = args[0];

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printUsage();
    return 0;
  }

  if (subcommand === "run") {
    const { parsed, explicitAgainst } = parseEvalSubcommandOptions(args.slice(1), cwd);
    if (explicitAgainst) {
      parsed.againstPath = explicitAgainst;
    }
    const runOptions = toRunOptions(parsed);

    if (hasSweepOptions(parsed.sweep)) {
      const sweep = await runSweep(runOptions, parsed.sweep);
      console.log(`Eval sweep complete. Artifacts: ${sweep.outputDir}`);
      console.log(`Sweep runs: ${sweep.aggregate.runCount}`);
      if (parsed.ciMode && sweep.aggregate.gatePassed === false) {
        console.error(
          `[CI-GATE] Sweep failed: ${sweep.aggregate.failedGateRuns ?? 0} run(s) violated budget/baseline gates`
        );
        return 1;
      }
      return 0;
    }

    const result = await runEvaluation(runOptions);
    console.log(`Eval run complete. Artifacts: ${result.outputDir}`);
    console.log(
      `Hit@5=${(result.summary.metrics.hitAt5 * 100).toFixed(2)}% MRR@10=${result.summary.metrics.mrrAt10.toFixed(4)} p95=${result.summary.metrics.latencyMs.p95.toFixed(3)}ms`
    );

    if (result.gate && !result.gate.passed) {
      for (const violation of result.gate.violations) {
        console.error(`[CI-GATE] ${violation.metric}: ${violation.message}`);
      }
      return 1;
    }

    return 0;
  }

  if (subcommand === "compare") {
    const { parsed, explicitAgainst } = parseEvalSubcommandOptions(args.slice(1), cwd);

    if (!explicitAgainst) {
      throw new Error("eval compare requires --against <baseline summary.json>");
    }
    parsed.againstPath = explicitAgainst;

    const runOptions = toRunOptions(parsed);

    if (hasSweepOptions(parsed.sweep)) {
      const sweep = await runSweep(runOptions, parsed.sweep);
      console.log(`Eval compare sweep complete. Artifacts: ${sweep.outputDir}`);
      if (parsed.ciMode && sweep.aggregate.gatePassed === false) {
        console.error(
          `[CI-GATE] Sweep failed: ${sweep.aggregate.failedGateRuns ?? 0} run(s) violated budget/baseline gates`
        );
        return 1;
      }
      return 0;
    }

    const result = await runEvaluation(runOptions);
    console.log(`Eval compare complete. Artifacts: ${result.outputDir}`);
    return 0;
  }

  if (subcommand === "diff") {
    const { parsed, explicitAgainst } = parseEvalSubcommandOptions(args.slice(1), cwd);
    if (!explicitAgainst) {
      throw new Error("eval diff requires --against <baseline summary.json>");
    }
    if (!parsed.currentPath) {
      throw new Error("eval diff requires --current <current summary.json>");
    }
    parsed.againstPath = explicitAgainst;

    const currentPath = parsed.currentPath;
    if (!currentPath.endsWith(".json")) {
      throw new Error("eval diff --current must point to a summary JSON file");
    }
    if (!parsed.againstPath.endsWith(".json")) {
      throw new Error("eval diff --against must point to a summary JSON file");
    }
    const currentSummary = loadSummary(path.resolve(parsed.projectRoot, currentPath));
    const baselineSummary = loadSummary(path.resolve(parsed.projectRoot, parsed.againstPath));
    const comparison = compareSummaries(
      currentSummary,
      baselineSummary,
      path.resolve(parsed.projectRoot, parsed.againstPath)
    );

    const outputDir = createRunDirectory(path.resolve(parsed.projectRoot, parsed.outputRoot));
    const summaryMd = createSummaryMarkdown(currentSummary, comparison);
    writeJson(path.join(outputDir, "compare.json"), comparison);
    writeText(path.join(outputDir, "summary.md"), summaryMd);
    writeJson(path.join(outputDir, "summary.json"), currentSummary);
    console.log(`Eval diff complete. Artifacts: ${outputDir}`);
    return 0;
  }

  throw new Error(`Unknown eval subcommand: ${subcommand}`);
}
