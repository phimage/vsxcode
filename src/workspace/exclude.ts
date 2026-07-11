/** Configuration section + key for the discovery exclude patterns. */
export const CONFIG_SECTION = "xcodeProjectEditor";
export const EXCLUDE_KEY = "exclude";

/** Default patterns: skip dependencies and build-output project copies. */
export const DEFAULT_EXCLUDE: string[] = [
  "**/node_modules/**",
  "**/build/Debug/**",
  "**/build/Release/**",
  "**/DerivedData/**"
];

/**
 * Combines exclude glob patterns into a single VS Code glob usable as the
 * `exclude` argument of `workspace.findFiles`. Multiple patterns are joined with
 * brace expansion (`{a,b}`); an empty list yields `null` (exclude nothing).
 * Pure — no `vscode` dependency, so it is unit-testable.
 */
export function combineExcludeGlobs(patterns: string[]): string | null {
  const cleaned = patterns.map((p) => p.trim()).filter((p) => p.length > 0);
  if (cleaned.length === 0) {
    return null;
  }
  return cleaned.length === 1 ? cleaned[0] : `{${cleaned.join(",")}}`;
}
