import * as fs from "fs";
import * as path from "path";

// Vitest runs with the project root as cwd; fixtures live under test/fixtures.
export const fixturesDir = path.resolve(process.cwd(), "test", "fixtures");

export const sampleProjectRoot = fixturesDir;
export const samplePbxprojPath = path.join(fixturesDir, "Sample.xcodeproj", "project.pbxproj");

export function readFixture(relative: string): string {
  return fs.readFileSync(path.join(fixturesDir, relative), "utf8");
}
