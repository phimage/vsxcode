import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { PbxModel } from "../model/pbxProject";
import { PathResolver } from "../model/pathResolver";
import { combineExcludeGlobs, CONFIG_SECTION, DEFAULT_EXCLUDE, EXCLUDE_KEY } from "./exclude";

/** A discovered, parsed Xcode project. */
export interface LoadedProject {
  /** URI of the `project.pbxproj` file. */
  readonly pbxprojUri: vscode.Uri;
  /** Display name, e.g. `MyApp` for `MyApp.xcodeproj`. */
  readonly name: string;
  /** SOURCE_ROOT: the directory containing the `.xcodeproj` bundle. */
  readonly projectRoot: string;
  readonly text: string;
  readonly model: PbxModel;
  readonly resolver: PathResolver;
  /** Non-fatal parse error, if the file could not be parsed. */
  readonly error?: string;
}

const PBXPROJ_GLOB = "**/*.xcodeproj/project.pbxproj";

/** Reads the user's exclude patterns and combines them into one glob. */
function excludeGlob(): string | null {
  const patterns = vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<string[]>(EXCLUDE_KEY, DEFAULT_EXCLUDE);
  return combineExcludeGlobs(patterns);
}

/**
 * Finds every `project.pbxproj` in the workspace, skipping paths matched by the
 * `xcodeProjectEditor.exclude` setting (e.g. build/Debug, build/Release).
 */
export async function findXcodeProjects(): Promise<vscode.Uri[]> {
  const uris = await vscode.workspace.findFiles(PBXPROJ_GLOB, excludeGlob());
  return uris.sort((a, b) => a.fsPath.localeCompare(b.fsPath));
}

function loadProject(pbxprojUri: vscode.Uri): LoadedProject {
  const pbxprojPath = pbxprojUri.fsPath;
  const xcodeprojDir = path.dirname(pbxprojPath); // .../MyApp.xcodeproj
  const projectRoot = path.dirname(xcodeprojDir); // .../ (contains the bundle)
  const name = path.basename(xcodeprojDir).replace(/\.xcodeproj$/i, "");

  let text = "";
  try {
    text = fs.readFileSync(pbxprojPath, "utf8");
  } catch (err) {
    text = "";
    const model = PbxModel.parse("{ }");
    return {
      pbxprojUri,
      name,
      projectRoot,
      text,
      model,
      resolver: new PathResolver(model, projectRoot),
      error: `Cannot read file: ${(err as Error).message}`
    };
  }

  try {
    const model = PbxModel.parse(text);
    return {
      pbxprojUri,
      name,
      projectRoot,
      text,
      model,
      resolver: new PathResolver(model, projectRoot)
    };
  } catch (err) {
    const model = PbxModel.parse("{ }");
    return {
      pbxprojUri,
      name,
      projectRoot,
      text,
      model,
      resolver: new PathResolver(model, projectRoot),
      error: `Parse error: ${(err as Error).message}`
    };
  }
}

/** Loads and caches all discovered projects; reloads on demand. */
export class ProjectManager {
  private projects: LoadedProject[] = [];

  getProjects(): readonly LoadedProject[] {
    return this.projects;
  }

  getByUri(uri: vscode.Uri): LoadedProject | undefined {
    return this.projects.find((p) => p.pbxprojUri.toString() === uri.toString());
  }

  async reload(): Promise<readonly LoadedProject[]> {
    const uris = await findXcodeProjects();
    this.projects = uris.map(loadProject);
    return this.projects;
  }
}
