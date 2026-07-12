import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { PbxModel } from "../model/pbxProject";
import { PathResolver } from "../model/pathResolver";
import { XcScheme } from "../schemes/scheme";
import { isInsideXcodeproj, XcWorkspaceData } from "../xcworkspace/workspaceData";
import { combineExcludeGlobs, CONFIG_SECTION, DEFAULT_EXCLUDE, EXCLUDE_KEY } from "./exclude";

/** A shared scheme (`xcshareddata/xcschemes/<Name>.xcscheme`) of a bundle. */
export interface LoadedScheme {
  readonly uri: vscode.Uri;
  /** Display name, e.g. `MyApp` for `MyApp.xcscheme`. */
  readonly name: string;
  readonly scheme: XcScheme;
  /** Non-fatal parse error, if the file could not be parsed. */
  readonly error?: string;
}

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
  /** Shared schemes inside the `.xcodeproj` bundle. */
  readonly schemes: LoadedScheme[];
  /** Non-fatal parse error, if the file could not be parsed. */
  readonly error?: string;
}

/** A discovered, parsed Xcode workspace (`.xcworkspace` bundle). */
export interface LoadedWorkspace {
  /** URI of the `contents.xcworkspacedata` file. */
  readonly dataUri: vscode.Uri;
  /** Display name, e.g. `MyApp` for `MyApp.xcworkspace`. */
  readonly name: string;
  /** Path of the `.xcworkspace` bundle. */
  readonly bundlePath: string;
  /** Directory containing the `.xcworkspace` bundle (base for `container:`). */
  readonly containerDir: string;
  readonly text: string;
  readonly data: XcWorkspaceData;
  /** Absolute paths of every referenced `.xcodeproj` bundle. */
  readonly projectPaths: string[];
  /** Shared schemes inside the `.xcworkspace` bundle. */
  readonly schemes: LoadedScheme[];
  /** Non-fatal parse error, if the file could not be parsed. */
  readonly error?: string;
}

const PBXPROJ_GLOB = "**/*.xcodeproj/project.pbxproj";
const XCWORKSPACE_GLOB = "**/*.xcworkspace/contents.xcworkspacedata";

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

/**
 * Finds every real `.xcworkspace` in the VS Code workspace. The implicit
 * `project.xcworkspace` living inside every `.xcodeproj` bundle is skipped.
 */
export async function findXcodeWorkspaces(): Promise<vscode.Uri[]> {
  const uris = await vscode.workspace.findFiles(XCWORKSPACE_GLOB, excludeGlob());
  return uris
    .filter((uri) => !isInsideXcodeproj(uri.fsPath))
    .sort((a, b) => a.fsPath.localeCompare(b.fsPath));
}

/** Loads the shared schemes of an `.xcodeproj` or `.xcworkspace` bundle. */
function loadSchemes(bundlePath: string): LoadedScheme[] {
  const schemesDir = path.join(bundlePath, "xcshareddata", "xcschemes");
  let files: string[];
  try {
    files = fs.readdirSync(schemesDir).filter((f) => f.toLowerCase().endsWith(".xcscheme"));
  } catch {
    return []; // no shared schemes
  }
  return files.sort((a, b) => a.localeCompare(b)).map((file) => {
    const uri = vscode.Uri.file(path.join(schemesDir, file));
    const name = file.replace(/\.xcscheme$/i, "");
    try {
      return { uri, name, scheme: XcScheme.parse(fs.readFileSync(uri.fsPath, "utf8")) };
    } catch (err) {
      return {
        uri,
        name,
        scheme: XcScheme.parse("<Scheme></Scheme>"),
        error: `Cannot load scheme: ${(err as Error).message}`
      };
    }
  });
}

function loadProject(pbxprojUri: vscode.Uri): LoadedProject {
  const pbxprojPath = pbxprojUri.fsPath;
  const xcodeprojDir = path.dirname(pbxprojPath); // .../MyApp.xcodeproj
  const projectRoot = path.dirname(xcodeprojDir); // .../ (contains the bundle)
  const name = path.basename(xcodeprojDir).replace(/\.xcodeproj$/i, "");
  const schemes = loadSchemes(xcodeprojDir);

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
      schemes,
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
      resolver: new PathResolver(model, projectRoot),
      schemes
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
      schemes,
      error: `Parse error: ${(err as Error).message}`
    };
  }
}

function loadWorkspace(dataUri: vscode.Uri): LoadedWorkspace {
  const dataPath = dataUri.fsPath;
  const bundlePath = path.dirname(dataPath); // .../MyApp.xcworkspace
  const containerDir = path.dirname(bundlePath);
  const name = path.basename(bundlePath).replace(/\.xcworkspace$/i, "");

  let text = "";
  let data = XcWorkspaceData.empty();
  let error: string | undefined;
  try {
    text = fs.readFileSync(dataPath, "utf8");
    data = XcWorkspaceData.parse(text);
  } catch (err) {
    error = `Cannot load workspace: ${(err as Error).message}`;
  }

  const projectPaths: string[] = [];
  for (const ref of data.allFileRefs()) {
    const resolved = data.resolveItem(ref.id, containerDir);
    if (resolved !== null && resolved.toLowerCase().endsWith(".xcodeproj")) {
      projectPaths.push(resolved);
    }
  }

  return {
    dataUri,
    name,
    bundlePath,
    containerDir,
    text,
    data,
    projectPaths,
    schemes: loadSchemes(bundlePath),
    error
  };
}

/** Loads and caches all discovered projects and workspaces; reloads on demand. */
export class ProjectManager {
  private projects: LoadedProject[] = [];
  private workspaces: LoadedWorkspace[] = [];
  /** Normalized `.xcodeproj` dirs referenced by at least one workspace. */
  private workspaceOwned = new Set<string>();
  /** Normalized `.xcodeproj` dir → loaded project. */
  private byXcodeprojDir = new Map<string, LoadedProject>();

  getProjects(): readonly LoadedProject[] {
    return this.projects;
  }

  getWorkspaces(): readonly LoadedWorkspace[] {
    return this.workspaces;
  }

  getByUri(uri: vscode.Uri): LoadedProject | undefined {
    return this.projects.find((p) => p.pbxprojUri.toString() === uri.toString());
  }

  getWorkspaceByUri(uri: vscode.Uri): LoadedWorkspace | undefined {
    return this.workspaces.find((w) => w.dataUri.toString() === uri.toString());
  }

  /** Loaded project for an absolute `.xcodeproj` bundle path, if any. */
  getProjectByXcodeprojPath(xcodeprojPath: string): LoadedProject | undefined {
    return this.byXcodeprojDir.get(normalizeKey(xcodeprojPath));
  }

  /** True when the project is referenced by a discovered workspace. */
  isWorkspaceProject(project: LoadedProject): boolean {
    return this.workspaceOwned.has(normalizeKey(path.dirname(project.pbxprojUri.fsPath)));
  }

  async reload(): Promise<readonly LoadedProject[]> {
    const [projectUris, workspaceUris] = await Promise.all([
      findXcodeProjects(),
      findXcodeWorkspaces()
    ]);
    this.workspaces = workspaceUris.map(loadWorkspace);

    this.byXcodeprojDir = new Map();
    for (const uri of projectUris) {
      const project = loadProject(uri);
      this.byXcodeprojDir.set(normalizeKey(path.dirname(uri.fsPath)), project);
    }

    // Workspaces may reference projects outside the VS Code folders (or ones
    // the glob missed); load those directly from disk.
    this.workspaceOwned = new Set();
    for (const workspace of this.workspaces) {
      for (const projectPath of workspace.projectPaths) {
        const key = normalizeKey(projectPath);
        if (!this.byXcodeprojDir.has(key)) {
          const pbxproj = path.join(projectPath, "project.pbxproj");
          if (fs.existsSync(pbxproj)) {
            this.byXcodeprojDir.set(key, loadProject(vscode.Uri.file(pbxproj)));
          }
        }
        if (this.byXcodeprojDir.has(key)) {
          this.workspaceOwned.add(key);
        }
      }
    }

    this.projects = [...this.byXcodeprojDir.values()].sort((a, b) =>
      a.pbxprojUri.fsPath.localeCompare(b.pbxprojUri.fsPath)
    );
    return this.projects;
  }
}

function normalizeKey(fsPath: string): string {
  const normalized = path.normalize(fsPath);
  // Windows paths are case-insensitive; macOS usually too, but keep exact there
  // to avoid conflating genuinely different paths on case-sensitive volumes.
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
