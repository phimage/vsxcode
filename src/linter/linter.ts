import {
  brokenConfigurationRule,
  brokenReferenceRule,
  circularGroupRule,
  duplicateFileRule,
  duplicateUuidRule,
  LintContext,
  missingFileRule,
  PlainDiagnostic
} from "./rules";

export { PlainDiagnostic, LintContext, Severity } from "./rules";

/**
 * Runs every lint rule over a parsed project model and returns a de-duplicated,
 * source-ordered list of diagnostics. Pure — the caller maps offsets to VS Code
 * ranges. Disk-dependent rules are skipped unless `projectRoot`/`fileExists` are
 * supplied in the context.
 */
export function lint(ctx: LintContext): PlainDiagnostic[] {
  const { model } = ctx;
  const all: PlainDiagnostic[] = [
    ...duplicateUuidRule(model),
    ...brokenReferenceRule(model),
    ...circularGroupRule(model),
    ...brokenConfigurationRule(model),
    ...missingFileRule(ctx),
    ...duplicateFileRule(ctx)
  ];

  const seen = new Set<string>();
  const deduped: PlainDiagnostic[] = [];
  for (const d of all) {
    const key = `${d.code}:${d.start}:${d.end}:${d.message}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(d);
  }
  deduped.sort((a, b) => a.start - b.start || a.end - b.end);
  return deduped;
}
