import type { EvalBudget, EvalComparison, EvalGateResult, EvalSummary } from "./types.js";

export function evaluateBudgetGate(
  budget: EvalBudget,
  summary: EvalSummary,
  comparison?: EvalComparison
): EvalGateResult {
  const BASELINE_P95_EPSILON_MS = 0.001;
  const violations: EvalGateResult["violations"] = [];

  const { thresholds } = budget;

  if (thresholds.minHitAt5 !== undefined && summary.metrics.hitAt5 < thresholds.minHitAt5) {
    violations.push({
      metric: "minHitAt5",
      message: `Hit@5 ${summary.metrics.hitAt5.toFixed(4)} is below minimum ${thresholds.minHitAt5.toFixed(4)}`,
    });
  }

  if (thresholds.minMrrAt10 !== undefined && summary.metrics.mrrAt10 < thresholds.minMrrAt10) {
    violations.push({
      metric: "minMrrAt10",
      message: `MRR@10 ${summary.metrics.mrrAt10.toFixed(4)} is below minimum ${thresholds.minMrrAt10.toFixed(4)}`,
    });
  }

  if (comparison) {
    if (
      thresholds.hitAt5MaxDrop !== undefined &&
      comparison.deltas.hitAt5.absolute < -thresholds.hitAt5MaxDrop
    ) {
      violations.push({
        metric: "hitAt5MaxDrop",
        message: `Hit@5 drop ${comparison.deltas.hitAt5.absolute.toFixed(4)} exceeds allowed -${thresholds.hitAt5MaxDrop.toFixed(4)}`,
      });
    }

    if (
      thresholds.mrrAt10MaxDrop !== undefined &&
      comparison.deltas.mrrAt10.absolute < -thresholds.mrrAt10MaxDrop
    ) {
      violations.push({
        metric: "mrrAt10MaxDrop",
        message: `MRR@10 drop ${comparison.deltas.mrrAt10.absolute.toFixed(4)} exceeds allowed -${thresholds.mrrAt10MaxDrop.toFixed(4)}`,
      });
    }

    if (thresholds.p95LatencyMaxMultiplier !== undefined) {
      const baselineP95 = comparison.deltas.latencyP95Ms.baseline;
      if (baselineP95 > BASELINE_P95_EPSILON_MS) {
        const allowed = baselineP95 * thresholds.p95LatencyMaxMultiplier;
        if (summary.metrics.latencyMs.p95 > allowed) {
          violations.push({
            metric: "p95LatencyMaxMultiplier",
            message: `p95 latency ${summary.metrics.latencyMs.p95.toFixed(3)}ms exceeds allowed ${allowed.toFixed(3)}ms (${thresholds.p95LatencyMaxMultiplier.toFixed(2)}x baseline)`,
          });
        }
      }
    }
  }

  if (
    thresholds.p95LatencyMaxAbsoluteMs !== undefined &&
    summary.metrics.latencyMs.p95 > thresholds.p95LatencyMaxAbsoluteMs
  ) {
    violations.push({
      metric: "p95LatencyMaxAbsoluteMs",
      message: `p95 latency ${summary.metrics.latencyMs.p95.toFixed(3)}ms exceeds absolute maximum ${thresholds.p95LatencyMaxAbsoluteMs.toFixed(3)}ms`,
    });
  }

  return {
    passed: violations.length === 0,
    budgetName: budget.name,
    violations,
  };
}
