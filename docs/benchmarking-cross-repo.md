# Cross-repo benchmarking

This guide documents how to run the cross-repo benchmark runner in a portable way.

## What it measures

- Plugin retrieval quality (`codebase-index`) via eval harness
- `ripgrep` keyword baseline
- `ast-grep` structural baseline

Metrics reported per repo and aggregated:

- Hit@1/3/5/10
- MRR@10
- nDCG@10
- Latency p50/p95/p99

## Prerequisites

- Built project dependencies (`npm install`)
- `rg` installed
- `sg` installed (`brew install ast-grep` on macOS)

## Configure repositories (required)

You must provide repository paths explicitly.

Option A: CLI flag

```bash
npx tsx scripts/cross-repo-benchmark.ts --repos /path/to/repo1,/path/to/repo2
```

Option B: environment variable

```bash
export BENCHMARK_REPOS=/path/to/repo1,/path/to/repo2
npx tsx scripts/cross-repo-benchmark.ts
```

## Reindex modes

- Default: `--no-reindex` behavior (fast iteration, reuses existing index)
- Clean run: `--reindex` (rebuild index for reproducible baseline)

Examples:

```bash
# Fast iteration (default)
npx tsx scripts/cross-repo-benchmark.ts --repos /path/to/repo1,/path/to/repo2

# Clean baseline
npx tsx scripts/cross-repo-benchmark.ts --repos /path/to/repo1,/path/to/repo2 --reindex
```

## Optional baseline toggles

```bash
# Skip ripgrep baseline
npx tsx scripts/cross-repo-benchmark.ts --repos /path/to/repo1,/path/to/repo2 --skip-ripgrep

# Skip ast-grep baseline
npx tsx scripts/cross-repo-benchmark.ts --repos /path/to/repo1,/path/to/repo2 --skip-sg
```

## Output artifacts

Each run writes to:

- `benchmarks/results/cross-repo/<timestamp>/report.md`
- `benchmarks/results/cross-repo/<timestamp>/report.json`
- `benchmarks/results/cross-repo/<timestamp>/repos/<repo>.json`

Auto-generated dataset files are written to:

- `benchmarks/golden/cross-repo/<repo>.json`
