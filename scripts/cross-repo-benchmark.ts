#!/usr/bin/env node

import { execFile } from "child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import * as os from "os";
import * as path from "path";
import { performance } from "perf_hooks";
import { promisify } from "util";

import { buildPerQueryResult, computeEvalMetrics } from "../src/eval/metrics.js";
import { runEvaluation } from "../src/eval/runner.js";
import { parseGoldenDataset } from "../src/eval/schema.js";
import type {
  EvalMetrics,
  EvalRunOptions,
  GoldenDataset,
  GoldenQuery,
  GoldenQueryType,
  PerQueryEvalResult,
} from "../src/eval/types.js";
import { parseFiles, type CodeChunk, type FileInput, type ParsedFile } from "../src/native/index.js";

const execFileAsync = promisify(execFile);

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".cs",
  ".rb",
  ".sh",
  ".bash",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".json",
  ".toml",
  ".yaml",
  ".yml",
]);

const EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "target",
  ".next",
  ".turbo",
  ".cache",
  "vendor",
  "tmp",
  "temp",
]);

const MAX_FILE_SIZE_BYTES = 1_000_000;
const MAX_PARSE_FILES = 2500;

interface CliOptions {
  repos: string[];
  outputRoot: string;
  reindex: boolean;
  skipRipgrep: boolean;
  skipSg: boolean;
}

interface SymbolCandidate {
  filePath: string;
  symbol: string;
  chunkType: "function" | "class";
  content: string;
}

type CanonicalChunkType = "function" | "class" | undefined;

interface RepoBenchmarkResult {
  repoName: string;
  repoPath: string;
  datasetPath: string;
  datasetQueryCount: number;
  plugin: {
    outputDir: string;
    summaryPath: string;
    perQueryPath: string;
    metrics: EvalMetrics;
  };
  ripgrep?: {
    metrics: EvalMetrics;
    perQueryCount: number;
  };
  sg?: {
    metrics: EvalMetrics;
    perQueryCount: number;
  };
  error?: string;
}

interface RipgrepJsonPath {
  text?: string;
}

interface RipgrepJsonData {
  path?: RipgrepJsonPath;
}

interface RipgrepJsonEvent {
  type?: string;
  data?: RipgrepJsonData;
}

function printUsage(): void {
  console.log(`Usage:
npx tsx scripts/cross-repo-benchmark.ts [--repos /path/a,/path/b] [--output benchmarks/results/cross-repo] [--reindex|--no-reindex] [--skip-ripgrep] [--skip-sg]

Defaults:
  repos: ~/dev/git/demo-repos/{axios,express}
  output: benchmarks/results/cross-repo
  reindex: true
`);
}

function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function normalizePathForMatch(input: string): string {
  return input.replace(/\\/g, "/");
}

function ensureDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true });
}

function timestampForDir(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function toRepoName(repoPath: string): string {
  return path.basename(repoPath.replace(/[\\/]+$/, ""));
}

function parseCliArgs(argv: string[]): CliOptions {
  const defaultRepos = ["axios", "express"].map((repo) =>
    path.join(os.homedir(), "dev", "git", "demo-repos", repo)
  );

  let repos = [...defaultRepos];
  let outputRoot = path.resolve(process.cwd(), "benchmarks/results/cross-repo");
  let reindex = true;
  let skipRipgrep = false;
  let skipSg = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }

    if (arg === "--repos") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--repos requires a comma-separated value");
      }
      repos = value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
        .map((item) => path.resolve(expandHome(item)));
      i += 1;
      continue;
    }

    if (arg === "--output") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--output requires a path");
      }
      outputRoot = path.resolve(expandHome(value));
      i += 1;
      continue;
    }

    if (arg === "--reindex") {
      reindex = true;
      continue;
    }

    if (arg === "--no-reindex") {
      reindex = false;
      continue;
    }

    if (arg === "--skip-ripgrep") {
      skipRipgrep = true;
      continue;
    }

    if (arg === "--skip-sg") {
      skipSg = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    repos,
    outputRoot,
    reindex,
    skipRipgrep,
    skipSg,
  };
}

function collectSourceFiles(repoPath: string): string[] {
  const files: string[] = [];
  const stack: string[] = [repoPath];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;

    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);

      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        stack.push(absolutePath);
        continue;
      }

      if (!entry.isFile()) continue;

      const ext = path.extname(entry.name).toLowerCase();
      if (!SOURCE_EXTENSIONS.has(ext)) continue;
      if (entry.name.endsWith(".min.js") || entry.name.endsWith(".min.css")) continue;

      const stat = readFileSync(absolutePath, { encoding: "utf-8", flag: "r" });
      if (Buffer.byteLength(stat, "utf-8") > MAX_FILE_SIZE_BYTES) continue;

      files.push(absolutePath);
      if (files.length >= MAX_PARSE_FILES) {
        return files;
      }
    }
  }

  return files;
}

function extractNamedExports(content: string): Set<string> {
  const names = new Set<string>();

  const directRegexes = [
    /export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
    /export\s+(?:default\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
    /export\s+(?:const|let|var|type|interface|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
    /exports\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g,
  ];

  for (const regex of directRegexes) {
    for (const match of content.matchAll(regex)) {
      const candidate = match[1];
      if (candidate) names.add(candidate);
    }
  }

  for (const blockMatch of content.matchAll(/export\s*\{([^}]+)\}/g)) {
    const inside = blockMatch[1];
    const entries = inside.split(",").map((part) => part.trim());
    for (const entry of entries) {
      if (!entry) continue;
      const asParts = entry.split(/\s+as\s+/i).map((part) => part.trim());
      const exported = asParts.length === 2 ? asParts[1] : asParts[0];
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(exported)) {
        names.add(exported);
      }
    }
  }

  return names;
}

function getCanonicalChunkType(chunkType: string): CanonicalChunkType {
  const lowered = chunkType.toLowerCase();
  if (
    lowered.includes("function") ||
    lowered === "method" ||
    lowered.includes("arrow") ||
    lowered.includes("callable")
  ) {
    return "function";
  }

  if (lowered.includes("class")) {
    return "class";
  }

  return undefined;
}

function isFunctionOrClass(chunk: CodeChunk): chunk is CodeChunk & { name: string } {
  if (!chunk.name) return false;
  return getCanonicalChunkType(chunk.chunkType) !== undefined;
}

function buildSymbolCandidates(parsedFiles: ParsedFile[], repoPath: string): SymbolCandidate[] {
  const candidates: SymbolCandidate[] = [];
  const fallbackCandidates: SymbolCandidate[] = [];

  for (const parsedFile of parsedFiles) {
    const relativePath = normalizePathForMatch(path.relative(repoPath, parsedFile.path));
    const exportedNames = new Set<string>();

    for (const chunk of parsedFile.chunks) {
      if (chunk.chunkType === "export") {
        const names = extractNamedExports(chunk.content);
        for (const name of names) exportedNames.add(name);
      }
    }

    for (const chunk of parsedFile.chunks) {
      if (!isFunctionOrClass(chunk)) continue;

      const canonicalType = getCanonicalChunkType(chunk.chunkType);
      if (!canonicalType) continue;

      const candidate: SymbolCandidate = {
        filePath: relativePath,
        symbol: chunk.name,
        chunkType: canonicalType,
        content: chunk.content,
      };

      const looksExported =
        exportedNames.has(chunk.name) ||
        /(^|\n)\s*export\s+/m.test(chunk.content) ||
        /module\.exports|exports\./.test(chunk.content);

      if (looksExported) {
        candidates.push(candidate);
      } else {
        fallbackCandidates.push(candidate);
      }
    }
  }

  const unique = new Map<string, SymbolCandidate>();
  const merged = [...candidates, ...fallbackCandidates];

  for (const candidate of merged) {
    const key = `${candidate.filePath}::${candidate.symbol}`;
    if (!unique.has(key)) {
      unique.set(key, candidate);
    }
  }

  return Array.from(unique.values()).sort((a, b) => a.filePath.localeCompare(b.filePath));
}

function extractConcept(content: string): string {
  const lowered = content.toLowerCase();
  const concepts = [
    "routing",
    "middleware",
    "request handling",
    "response formatting",
    "error handling",
    "configuration",
    "state management",
    "theme composition",
    "validation",
    "caching",
    "logging",
    "serialization",
    "parsing",
    "build orchestration",
    "runtime compatibility",
  ];

  for (const concept of concepts) {
    const term = concept.split(" ")[0];
    if (lowered.includes(term)) return concept;
  }

  return "core behavior";
}

function extractIdentifiers(content: string): string[] {
  const stopwords = new Set([
    "const",
    "function",
    "class",
    "return",
    "export",
    "import",
    "from",
    "true",
    "false",
    "null",
    "undefined",
    "while",
    "for",
    "await",
    "async",
    "this",
    "that",
    "with",
    "query",
    "where",
    "handle",
    "does",
  ]);

  const counts = new Map<string, number>();
  for (const match of content.matchAll(/\b[A-Za-z_][A-Za-z0-9_]{3,}\b/g)) {
    const token = match[0];
    const lowered = token.toLowerCase();
    if (stopwords.has(lowered)) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([token]) => token)
    .slice(0, 8);
}

function pickDistinctFiles(candidates: SymbolCandidate[], limit: number): SymbolCandidate[] {
  const picked: SymbolCandidate[] = [];
  const seenFiles = new Set<string>();

  for (const candidate of candidates) {
    if (seenFiles.has(candidate.filePath)) continue;
    picked.push(candidate);
    seenFiles.add(candidate.filePath);
    if (picked.length >= limit) break;
  }

  if (picked.length < limit) {
    for (const candidate of candidates) {
      if (picked.length >= limit) break;
      if (picked.some((item) => item.filePath === candidate.filePath && item.symbol === candidate.symbol)) {
        continue;
      }
      picked.push(candidate);
    }
  }

  return picked;
}

function buildGoldenDataset(repoName: string, repoPath: string, parsedFiles: ParsedFile[]): GoldenDataset {
  const candidates = buildSymbolCandidates(parsedFiles, repoPath);
  if (candidates.length === 0) {
    throw new Error(`No function/class candidates discovered in ${repoName}`);
  }

  const definitions = pickDistinctFiles(candidates, 3);
  const implementation = pickDistinctFiles(candidates.slice(3).length > 0 ? candidates.slice(3) : candidates, 3);
  const similarities = pickDistinctFiles(candidates.slice(6).length > 0 ? candidates.slice(6) : candidates, 2);
  const keywordHeavy = pickDistinctFiles(candidates.slice(8).length > 0 ? candidates.slice(8) : candidates, 2);

  const queries: GoldenQuery[] = [];
  let counter = 1;

  const addQuery = (queryType: GoldenQueryType, query: string, expected: GoldenQuery["expected"]): void => {
    queries.push({
      id: `${repoName}-${queryType}-${String(counter).padStart(2, "0")}`,
      query,
      queryType,
      expected,
    });
    counter += 1;
  };

  for (const candidate of definitions) {
    addQuery("definition", `where is ${candidate.symbol} defined`, {
      filePath: candidate.filePath,
      symbol: candidate.symbol,
    });
  }

  for (const candidate of implementation) {
    const moduleName = path.basename(candidate.filePath, path.extname(candidate.filePath));
    const concept = extractConcept(candidate.content);
    addQuery("implementation-intent", `how does ${moduleName} handle ${concept}`, {
      acceptableFiles: [candidate.filePath],
    });
  }

  for (const candidate of similarities) {
    const concept = extractConcept(candidate.content);
    addQuery("similarity", `${concept} ${candidate.chunkType} pattern with ${candidate.symbol}`, {
      acceptableFiles: [candidate.filePath],
    });
  }

  for (const candidate of keywordHeavy) {
    const identifiers = extractIdentifiers(candidate.content);
    const terms = [candidate.symbol, ...identifiers].slice(0, 4);
    addQuery("keyword-heavy", terms.join(" "), {
      acceptableFiles: [candidate.filePath],
    });
  }

  const boundedQueries = queries.slice(0, 12);
  if (boundedQueries.length < 8) {
    throw new Error(`Generated only ${boundedQueries.length} queries for ${repoName}; need at least 8`);
  }

  return {
    version: "1.0.0",
    name: `cross-repo-${repoName}`,
    description: `Auto-generated cross-repo benchmark dataset for ${repoName}`,
    queries: boundedQueries,
  };
}

function collectParsedFiles(repoPath: string): ParsedFile[] {
  const filePaths = collectSourceFiles(repoPath);
  if (filePaths.length === 0) {
    throw new Error(`No source files found for parsing in ${repoPath}`);
  }

  const inputs: FileInput[] = filePaths.map((filePath) => ({
    path: filePath,
    content: readFileSync(filePath, "utf-8"),
  }));

  return parseFiles(inputs);
}

function writeDataset(datasetPath: string, dataset: GoldenDataset): void {
  ensureDir(path.dirname(datasetPath));
  parseGoldenDataset(dataset, datasetPath);
  writeFileSync(datasetPath, JSON.stringify(dataset, null, 2), "utf-8");
}

function escapeRegexLiteral(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildRipgrepPattern(query: GoldenQuery): string {
  const terms = new Set<string>();

  if (query.expected.symbol) {
    terms.add(query.expected.symbol);
  }

  for (const part of query.query.split(/\s+/)) {
    const token = part.trim().replace(/[^A-Za-z0-9_$]/g, "");
    if (token.length >= 3) terms.add(token);
    if (terms.size >= 6) break;
  }

  if (terms.size === 0) {
    terms.add(query.query.slice(0, 32));
  }

  return Array.from(terms)
    .slice(0, 6)
    .map((term) => escapeRegexLiteral(term))
    .join("|");
}

function parseRipgrepEvents(stdout: string, repoPath: string): string[] {
  const found = new Set<string>();
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    const event = parsed as RipgrepJsonEvent;
    if (event.type !== "match") continue;

    const textPath = event.data?.path?.text;
    if (!textPath) continue;
    const relative = normalizePathForMatch(path.relative(repoPath, textPath));
    if (relative && !relative.startsWith("..")) {
      found.add(relative);
    }
    if (found.size >= 10) {
      break;
    }
  }

  return Array.from(found);
}

function parseSgEvents(stdout: string, repoPath: string): string[] {
  const found = new Set<string>();
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (typeof parsed !== "object" || parsed === null) continue;
    const maybeFile = (parsed as { file?: unknown }).file;
    if (typeof maybeFile !== "string") continue;

    const relative = normalizePathForMatch(path.relative(repoPath, maybeFile));
    if (relative && !relative.startsWith("..")) {
      found.add(relative);
    }
    if (found.size >= 10) {
      break;
    }
  }

  return Array.from(found);
}

async function runRipgrepBaseline(
  repoPath: string,
  dataset: GoldenDataset
): Promise<{ metrics: EvalMetrics; perQuery: PerQueryEvalResult[] }> {
  const perQuery: PerQueryEvalResult[] = [];

  for (const query of dataset.queries) {
    const pattern = buildRipgrepPattern(query);
    const start = performance.now();

    let stdout = "";
    try {
      const result = await execFileAsync("rg", ["--json", "--max-count", "10", "-e", pattern, repoPath], {
        maxBuffer: 10 * 1024 * 1024,
      });
      stdout = result.stdout;
    } catch (error: unknown) {
      const maybe = error as { stdout?: string; code?: number };
      if (typeof maybe.stdout === "string") {
        stdout = maybe.stdout;
      }
      if (maybe.code !== 1 && maybe.code !== 0) {
        throw error;
      }
    }

    const elapsed = performance.now() - start;
    const files = parseRipgrepEvents(stdout, repoPath);
    const results = files.map((filePath, index) => ({
      filePath,
      startLine: 0,
      endLine: 0,
      score: 1 / (index + 1),
      chunkType: "other",
      name: undefined,
    }));

    perQuery.push(buildPerQueryResult(query, results, elapsed, 10));
  }

  const metrics = computeEvalMetrics(dataset.queries, perQuery, 0, 0, 0);
  return { metrics, perQuery };
}

async function runSgBaseline(
  repoPath: string,
  dataset: GoldenDataset
): Promise<{ metrics: EvalMetrics; perQuery: PerQueryEvalResult[] }> {
  const perQuery: PerQueryEvalResult[] = [];

  for (const query of dataset.queries) {
    const pattern = query.expected.symbol ?? query.query.split(/\s+/).find((part) => /^[A-Za-z_$][A-Za-z0-9_$]{2,}$/.test(part)) ?? query.query;
    const start = performance.now();

    let stdout = "";
    try {
      const result = await execFileAsync("sg", ["run", "--pattern", pattern, "--json=stream", repoPath], {
        maxBuffer: 10 * 1024 * 1024,
      });
      stdout = result.stdout;
    } catch (error: unknown) {
      const maybe = error as { stdout?: string; code?: number };
      if (typeof maybe.stdout === "string") {
        stdout = maybe.stdout;
      }
      if (maybe.code !== 1 && maybe.code !== 0) {
        throw error;
      }
    }

    const elapsed = performance.now() - start;
    const files = parseSgEvents(stdout, repoPath);
    const results = files.map((filePath, index) => ({
      filePath,
      startLine: 0,
      endLine: 0,
      score: 1 / (index + 1),
      chunkType: "other",
      name: undefined,
    }));

    perQuery.push(buildPerQueryResult(query, results, elapsed, 10));
  }

  const metrics = computeEvalMetrics(dataset.queries, perQuery, 0, 0, 0);
  return { metrics, perQuery };
}

function averageMetrics(metricsList: EvalMetrics[]): EvalMetrics {
  if (metricsList.length === 0) {
    return {
      hitAt1: 0,
      hitAt3: 0,
      hitAt5: 0,
      hitAt10: 0,
      mrrAt10: 0,
      ndcgAt10: 0,
      latencyMs: { p50: 0, p95: 0, p99: 0 },
      tokenEstimate: { queryTokens: 0, embeddingTokensUsed: 0 },
      embedding: { callCount: 0, estimatedCostUsd: 0, costPer1MTokensUsd: 0 },
      failureBuckets: {
        "wrong-file": 0,
        "wrong-symbol": 0,
        "docs-tests-outranking-source": 0,
        "no-relevant-hit-top-k": 0,
      },
    };
  }

  const divisor = metricsList.length;
  const sum = metricsList.reduce(
    (acc, item) => {
      acc.hitAt1 += item.hitAt1;
      acc.hitAt3 += item.hitAt3;
      acc.hitAt5 += item.hitAt5;
      acc.hitAt10 += item.hitAt10;
      acc.mrrAt10 += item.mrrAt10;
      acc.ndcgAt10 += item.ndcgAt10;
      acc.latencyP50 += item.latencyMs.p50;
      acc.latencyP95 += item.latencyMs.p95;
      acc.latencyP99 += item.latencyMs.p99;
      acc.queryTokens += item.tokenEstimate.queryTokens;
      acc.embeddingTokensUsed += item.tokenEstimate.embeddingTokensUsed;
      acc.embeddingCallCount += item.embedding.callCount;
      acc.embeddingCost += item.embedding.estimatedCostUsd;
      acc.failureWrongFile += item.failureBuckets["wrong-file"];
      acc.failureWrongSymbol += item.failureBuckets["wrong-symbol"];
      acc.failureDocsTests += item.failureBuckets["docs-tests-outranking-source"];
      acc.failureNoRelevant += item.failureBuckets["no-relevant-hit-top-k"];
      return acc;
    },
    {
      hitAt1: 0,
      hitAt3: 0,
      hitAt5: 0,
      hitAt10: 0,
      mrrAt10: 0,
      ndcgAt10: 0,
      latencyP50: 0,
      latencyP95: 0,
      latencyP99: 0,
      queryTokens: 0,
      embeddingTokensUsed: 0,
      embeddingCallCount: 0,
      embeddingCost: 0,
      failureWrongFile: 0,
      failureWrongSymbol: 0,
      failureDocsTests: 0,
      failureNoRelevant: 0,
    }
  );

  return {
    hitAt1: sum.hitAt1 / divisor,
    hitAt3: sum.hitAt3 / divisor,
    hitAt5: sum.hitAt5 / divisor,
    hitAt10: sum.hitAt10 / divisor,
    mrrAt10: sum.mrrAt10 / divisor,
    ndcgAt10: sum.ndcgAt10 / divisor,
    latencyMs: {
      p50: sum.latencyP50 / divisor,
      p95: sum.latencyP95 / divisor,
      p99: sum.latencyP99 / divisor,
    },
    tokenEstimate: {
      queryTokens: Math.round(sum.queryTokens / divisor),
      embeddingTokensUsed: Math.round(sum.embeddingTokensUsed / divisor),
    },
    embedding: {
      callCount: Math.round(sum.embeddingCallCount / divisor),
      estimatedCostUsd: sum.embeddingCost / divisor,
      costPer1MTokensUsd: 0,
    },
    failureBuckets: {
      "wrong-file": Math.round(sum.failureWrongFile / divisor),
      "wrong-symbol": Math.round(sum.failureWrongSymbol / divisor),
      "docs-tests-outranking-source": Math.round(sum.failureDocsTests / divisor),
      "no-relevant-hit-top-k": Math.round(sum.failureNoRelevant / divisor),
    },
  };
}

function pct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function num(value: number): string {
  return value.toFixed(4);
}

function ms(value: number): string {
  return value.toFixed(2);
}

function buildMetricTableRow(label: string, pluginValue: string, ripgrepValue: string): string {
  return `| ${label} | ${pluginValue} | ${ripgrepValue} |`;
}

function buildReportMarkdown(
  runAt: string,
  options: CliOptions,
  runDir: string,
  repoResults: RepoBenchmarkResult[]
): string {
  const lines: string[] = [];
  lines.push("# Cross-Repo Benchmark Report");
  lines.push("");
  lines.push(`- Generated at: ${runAt}`);
  lines.push(`- Output directory: ${runDir}`);
  lines.push(`- Reindex: ${options.reindex}`);
  lines.push(`- Ripgrep baseline: ${options.skipRipgrep ? "skipped" : "enabled"}`);
  lines.push(`- ast-grep baseline: ${options.skipSg ? "skipped" : "enabled"}`);
  lines.push("");

  for (const result of repoResults) {
    lines.push(`## ${result.repoName}`);
    lines.push("");
    lines.push(`- Repo: ${result.repoPath}`);
    lines.push(`- Dataset: ${result.datasetPath} (${result.datasetQueryCount} queries)`);
    if (result.error) {
      lines.push(`- Error: ${result.error}`);
      lines.push("");
      continue;
    }

    lines.push("| Metric | Plugin | Ripgrep | ast-grep |");
    lines.push("|---|---:|---:|---:|");

    const rgMetrics = result.ripgrep?.metrics;
    const sgMetrics = result.sg?.metrics;
    lines.push(`| Hit@1 | ${pct(result.plugin.metrics.hitAt1)} | ${rgMetrics ? pct(rgMetrics.hitAt1) : "N/A"} | ${sgMetrics ? pct(sgMetrics.hitAt1) : "N/A"} |`);
    lines.push(`| Hit@3 | ${pct(result.plugin.metrics.hitAt3)} | ${rgMetrics ? pct(rgMetrics.hitAt3) : "N/A"} | ${sgMetrics ? pct(sgMetrics.hitAt3) : "N/A"} |`);
    lines.push(`| Hit@5 | ${pct(result.plugin.metrics.hitAt5)} | ${rgMetrics ? pct(rgMetrics.hitAt5) : "N/A"} | ${sgMetrics ? pct(sgMetrics.hitAt5) : "N/A"} |`);
    lines.push(`| Hit@10 | ${pct(result.plugin.metrics.hitAt10)} | ${rgMetrics ? pct(rgMetrics.hitAt10) : "N/A"} | ${sgMetrics ? pct(sgMetrics.hitAt10) : "N/A"} |`);
    lines.push(`| MRR@10 | ${num(result.plugin.metrics.mrrAt10)} | ${rgMetrics ? num(rgMetrics.mrrAt10) : "N/A"} | ${sgMetrics ? num(sgMetrics.mrrAt10) : "N/A"} |`);
    lines.push(`| nDCG@10 | ${num(result.plugin.metrics.ndcgAt10)} | ${rgMetrics ? num(rgMetrics.ndcgAt10) : "N/A"} | ${sgMetrics ? num(sgMetrics.ndcgAt10) : "N/A"} |`);
    lines.push(`| Latency p50 (ms) | ${ms(result.plugin.metrics.latencyMs.p50)} | ${rgMetrics ? ms(rgMetrics.latencyMs.p50) : "N/A"} | ${sgMetrics ? ms(sgMetrics.latencyMs.p50) : "N/A"} |`);
    lines.push(`| Latency p95 (ms) | ${ms(result.plugin.metrics.latencyMs.p95)} | ${rgMetrics ? ms(rgMetrics.latencyMs.p95) : "N/A"} | ${sgMetrics ? ms(sgMetrics.latencyMs.p95) : "N/A"} |`);
    lines.push(`| Latency p99 (ms) | ${ms(result.plugin.metrics.latencyMs.p99)} | ${rgMetrics ? ms(rgMetrics.latencyMs.p99) : "N/A"} | ${sgMetrics ? ms(sgMetrics.latencyMs.p99) : "N/A"} |`);
    lines.push("");
  }

  const successful = repoResults.filter((item) => !item.error);
  const pluginAggregate = averageMetrics(successful.map((item) => item.plugin.metrics));
  const ripgrepSuccessful = successful.filter((item) => item.ripgrep).map((item) => item.ripgrep?.metrics).filter((item): item is EvalMetrics => item !== undefined);
  const ripgrepAggregate = ripgrepSuccessful.length > 0 ? averageMetrics(ripgrepSuccessful) : undefined;
  const sgSuccessful = successful.filter((item) => item.sg).map((item) => item.sg?.metrics).filter((item): item is EvalMetrics => item !== undefined);
  const sgAggregate = sgSuccessful.length > 0 ? averageMetrics(sgSuccessful) : undefined;

  lines.push("## Aggregate (Average Across Repos)");
  lines.push("");
  lines.push("| Metric | Plugin | Ripgrep | ast-grep |");
  lines.push("|---|---:|---:|---:|");
  lines.push(`| Hit@1 | ${pct(pluginAggregate.hitAt1)} | ${ripgrepAggregate ? pct(ripgrepAggregate.hitAt1) : "N/A"} | ${sgAggregate ? pct(sgAggregate.hitAt1) : "N/A"} |`);
  lines.push(`| Hit@3 | ${pct(pluginAggregate.hitAt3)} | ${ripgrepAggregate ? pct(ripgrepAggregate.hitAt3) : "N/A"} | ${sgAggregate ? pct(sgAggregate.hitAt3) : "N/A"} |`);
  lines.push(`| Hit@5 | ${pct(pluginAggregate.hitAt5)} | ${ripgrepAggregate ? pct(ripgrepAggregate.hitAt5) : "N/A"} | ${sgAggregate ? pct(sgAggregate.hitAt5) : "N/A"} |`);
  lines.push(`| Hit@10 | ${pct(pluginAggregate.hitAt10)} | ${ripgrepAggregate ? pct(ripgrepAggregate.hitAt10) : "N/A"} | ${sgAggregate ? pct(sgAggregate.hitAt10) : "N/A"} |`);
  lines.push(`| MRR@10 | ${num(pluginAggregate.mrrAt10)} | ${ripgrepAggregate ? num(ripgrepAggregate.mrrAt10) : "N/A"} | ${sgAggregate ? num(sgAggregate.mrrAt10) : "N/A"} |`);
  lines.push(`| nDCG@10 | ${num(pluginAggregate.ndcgAt10)} | ${ripgrepAggregate ? num(ripgrepAggregate.ndcgAt10) : "N/A"} | ${sgAggregate ? num(sgAggregate.ndcgAt10) : "N/A"} |`);
  lines.push(`| Latency p50 (ms) | ${ms(pluginAggregate.latencyMs.p50)} | ${ripgrepAggregate ? ms(ripgrepAggregate.latencyMs.p50) : "N/A"} | ${sgAggregate ? ms(sgAggregate.latencyMs.p50) : "N/A"} |`);
  lines.push(`| Latency p95 (ms) | ${ms(pluginAggregate.latencyMs.p95)} | ${ripgrepAggregate ? ms(ripgrepAggregate.latencyMs.p95) : "N/A"} | ${sgAggregate ? ms(sgAggregate.latencyMs.p95) : "N/A"} |`);
  lines.push(`| Latency p99 (ms) | ${ms(pluginAggregate.latencyMs.p99)} | ${ripgrepAggregate ? ms(ripgrepAggregate.latencyMs.p99) : "N/A"} | ${sgAggregate ? ms(sgAggregate.latencyMs.p99) : "N/A"} |`);
  lines.push("");

  const failed = repoResults.filter((item) => item.error);
  if (failed.length > 0) {
    lines.push("## Failures");
    lines.push("");
    for (const failure of failed) {
      lines.push(`- ${failure.repoName}: ${failure.error}`);
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

async function runForRepo(
  repoPath: string,
  options: CliOptions,
  runDir: string,
  datasetRoot: string
): Promise<RepoBenchmarkResult> {
  const repoName = toRepoName(repoPath);
  const datasetPath = path.join(datasetRoot, `${repoName}.json`);

  try {
    const parsedFiles = collectParsedFiles(repoPath);
    const dataset = buildGoldenDataset(repoName, repoPath, parsedFiles);
    writeDataset(datasetPath, dataset);

    const pluginOutputRoot = path.join(runDir, "plugin", repoName);
    const runOptions: EvalRunOptions = {
      projectRoot: repoPath,
      datasetPath,
      outputRoot: pluginOutputRoot,
      ciMode: false,
      reindex: options.reindex,
    };

    const pluginResult = await runEvaluation(runOptions);

    const result: RepoBenchmarkResult = {
      repoName,
      repoPath,
      datasetPath,
      datasetQueryCount: dataset.queries.length,
      plugin: {
        outputDir: pluginResult.outputDir,
        summaryPath: path.join(pluginResult.outputDir, "summary.json"),
        perQueryPath: path.join(pluginResult.outputDir, "per-query.json"),
        metrics: pluginResult.summary.metrics,
      },
    };

    if (!options.skipRipgrep) {
      const ripgrepResult = await runRipgrepBaseline(repoPath, dataset);
      result.ripgrep = {
        metrics: ripgrepResult.metrics,
        perQueryCount: ripgrepResult.perQuery.length,
      };
    }

    if (!options.skipSg) {
      const sgResult = await runSgBaseline(repoPath, dataset);
      result.sg = {
        metrics: sgResult.metrics,
        perQueryCount: sgResult.perQuery.length,
      };
    }

    return result;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      repoName,
      repoPath,
      datasetPath,
      datasetQueryCount: 0,
      plugin: {
        outputDir: "",
        summaryPath: "",
        perQueryPath: "",
        metrics: averageMetrics([]),
      },
      error: message,
    };
  }
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  const resolvedRepos = options.repos.map((repo) => path.resolve(expandHome(repo)));

  if (resolvedRepos.length === 0) {
    throw new Error("No repositories configured");
  }

  for (const repoPath of resolvedRepos) {
    if (!existsSync(repoPath)) {
      throw new Error(`Repository path does not exist: ${repoPath}`);
    }
  }

  const runTimestamp = timestampForDir();
  const runDir = path.join(options.outputRoot, runTimestamp);
  const datasetRoot = path.join(process.cwd(), "benchmarks", "golden", "cross-repo");

  ensureDir(runDir);
  ensureDir(path.join(runDir, "repos"));
  ensureDir(datasetRoot);

  console.log(`Cross-repo benchmark run: ${runTimestamp}`);
  console.log(`Output: ${runDir}`);

  const results: RepoBenchmarkResult[] = [];

  for (const repoPath of resolvedRepos) {
    const repoName = toRepoName(repoPath);
    console.log(`\n[${repoName}] generating dataset + running evaluations...`);
    const repoResult = await runForRepo(repoPath, options, runDir, datasetRoot);
    results.push(repoResult);

    const perRepoArtifactPath = path.join(runDir, "repos", `${repoName}.json`);
    writeFileSync(perRepoArtifactPath, JSON.stringify(repoResult, null, 2), "utf-8");

    if (repoResult.error) {
      console.log(`[${repoName}] failed: ${repoResult.error}`);
    } else {
      const rgHitAt5 = repoResult.ripgrep ? `, rg=${pct(repoResult.ripgrep.metrics.hitAt5)}` : "";
      const sgHitAt5 = repoResult.sg ? `, sg=${pct(repoResult.sg.metrics.hitAt5)}` : "";
      console.log(
        `[${repoName}] done: Hit@5 plugin=${pct(repoResult.plugin.metrics.hitAt5)}${rgHitAt5}${sgHitAt5}`
      );
    }
  }

  const reportMarkdown = buildReportMarkdown(new Date().toISOString(), options, runDir, results);
  const reportJson = {
    generatedAt: new Date().toISOString(),
    options: {
      repos: resolvedRepos,
      outputRoot: options.outputRoot,
      reindex: options.reindex,
      skipRipgrep: options.skipRipgrep,
      skipSg: options.skipSg,
    },
    runDir,
    repos: results,
    aggregate: {
      plugin: averageMetrics(results.filter((item) => !item.error).map((item) => item.plugin.metrics)),
      ripgrep: options.skipRipgrep
        ? undefined
        : averageMetrics(
            results
              .filter((item) => !item.error && item.ripgrep)
              .map((item) => item.ripgrep?.metrics)
              .filter((item): item is EvalMetrics => item !== undefined)
          ),
      sg: options.skipSg
        ? undefined
        : averageMetrics(
            results
              .filter((item) => !item.error && item.sg)
              .map((item) => item.sg?.metrics)
              .filter((item): item is EvalMetrics => item !== undefined)
          ),
    },
  };

  const reportMdPath = path.join(runDir, "report.md");
  const reportJsonPath = path.join(runDir, "report.json");

  writeFileSync(reportMdPath, reportMarkdown, "utf-8");
  writeFileSync(reportJsonPath, JSON.stringify(reportJson, null, 2), "utf-8");

  console.log(`\nReport written:`);
  console.log(`- ${reportMdPath}`);
  console.log(`- ${reportJsonPath}`);

  const failedCount = results.filter((item) => item.error).length;
  if (failedCount > 0) {
    console.log(`\nCompleted with ${failedCount} repo failure(s).`);
    process.exitCode = 1;
  } else {
    console.log("\nCompleted successfully.");
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
