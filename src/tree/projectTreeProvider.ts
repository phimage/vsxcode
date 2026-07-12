import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
  buildPhasesOf,
  packageReferences,
  phaseFileRefs,
  requirementSummary,
  targetInfo
} from "../model/queries";
import { PbxObject } from "../model/types";
import { XcWorkspaceItem, wsItemDisplayName } from "../xcworkspace/workspaceData";
import { LoadedProject, LoadedWorkspace, ProjectManager } from "../workspace/discovery";
import {
  BuildPhaseTreeNode,
  FileTreeNode,
  GroupTreeNode,
  PackageTreeNode,
  PbxTreeNode,
  SchemesSectionTreeNode,
  SchemeTreeNode,
  TargetTreeNode,
  WsFileRefTreeNode,
  WsGroupTreeNode
} from "./nodes";

export class ProjectTreeProvider implements vscode.TreeDataProvider<PbxTreeNode> {
  private readonly emitter = new vscode.EventEmitter<PbxTreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly manager: ProjectManager) {}

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(node: PbxTreeNode): vscode.TreeItem {
    switch (node.kind) {
      case "workspace":
        return this.workspaceItem(node.workspace);
      case "wsGroup":
        return this.wsGroupItem(node);
      case "wsFileRef":
        return this.wsFileRefItem(node);
      case "project":
        return this.projectItem(node.project, node.wsRef !== undefined);
      case "group":
        return this.groupItem(node.project, node.uuid);
      case "file":
        return this.fileItem(node);
      case "targetsSection":
        return sectionItem("Targets", "target", node.project.model.targets().length);
      case "target":
        return this.targetItem(node);
      case "buildPhase":
        return this.buildPhaseItem(node);
      case "packagesSection":
        return sectionItem("Package Dependencies", "package", packageReferences(node.project.model).length);
      case "package":
        return this.packageItem(node);
      case "schemesSection": {
        const count = (node.project?.schemes ?? node.workspace?.schemes ?? []).length;
        return sectionItem("Schemes", "play-circle", count);
      }
      case "scheme":
        return this.schemeItem(node);
      case "message": {
        const item = new vscode.TreeItem(node.message);
        item.iconPath = new vscode.ThemeIcon("warning");
        return item;
      }
    }
  }

  getChildren(element?: PbxTreeNode): PbxTreeNode[] {
    if (!element) {
      // Workspaces are roots; projects they reference nest below them. Only
      // projects not owned by any workspace stay at the top level.
      const roots: PbxTreeNode[] = this.manager
        .getWorkspaces()
        .map((workspace) => ({ kind: "workspace", workspace }));
      for (const project of this.manager.getProjects()) {
        if (!this.manager.isWorkspaceProject(project)) {
          roots.push({ kind: "project", project });
        }
      }
      return roots;
    }
    switch (element.kind) {
      case "workspace": {
        const { workspace } = element;
        if (workspace.error) {
          return [{ kind: "message", message: workspace.error }];
        }
        const nodes = this.wsChildNodes(workspace, workspace.data.items);
        if (workspace.schemes.length > 0) {
          nodes.push({ kind: "schemesSection", workspace } satisfies SchemesSectionTreeNode);
        }
        return nodes;
      }
      case "wsGroup": {
        const item = element.workspace.data.get(element.itemId);
        return item?.kind === "group" ? this.wsChildNodes(element.workspace, item.children) : [];
      }
      case "project": {
        const { project } = element;
        if (project.error) {
          return [{ kind: "message", message: project.error }];
        }
        const main = project.model.mainGroup();
        const nodes = main ? this.childNodes(project, main) : [];
        // Xcode-like extras after the file hierarchy.
        if (project.model.targets().length > 0) {
          nodes.push({ kind: "targetsSection", project });
        }
        if (packageReferences(project.model).length > 0) {
          nodes.push({ kind: "packagesSection", project });
        }
        if (project.schemes.length > 0) {
          nodes.push({ kind: "schemesSection", project } satisfies SchemesSectionTreeNode);
        }
        return nodes;
      }
      case "group": {
        const obj = element.project.model.get(element.uuid);
        return obj ? this.childNodes(element.project, obj) : [];
      }
      case "targetsSection":
        return element.project.model
          .targets()
          .map((t) => ({ kind: "target", project: element.project, uuid: t.uuid }) satisfies TargetTreeNode);
      case "target":
        return buildPhasesOf(element.project.model, element.uuid).map(
          (phase) =>
            ({ kind: "buildPhase", project: element.project, uuid: phase.uuid }) satisfies BuildPhaseTreeNode
        );
      case "buildPhase":
        return phaseFileRefs(element.project.model, element.uuid).map((fileRef) => {
          const resolvedPath = element.project.resolver.resolve(fileRef);
          const exists = resolvedPath !== null ? fs.existsSync(resolvedPath) : true;
          return {
            kind: "file",
            project: element.project,
            uuid: fileRef,
            resolvedPath,
            exists
          } satisfies FileTreeNode;
        });
      case "packagesSection":
        return packageReferences(element.project.model).map(
          (pkg) => ({ kind: "package", project: element.project, uuid: pkg.uuid }) satisfies PackageTreeNode
        );
      case "schemesSection": {
        const schemes = element.project?.schemes ?? element.workspace?.schemes ?? [];
        return schemes.map(
          (scheme) =>
            ({
              kind: "scheme",
              scheme,
              project: element.project,
              workspace: element.workspace
            }) satisfies SchemeTreeNode
        );
      }
      default:
        return [];
    }
  }

  getParent(): undefined {
    // Parent lookup is not needed for reveal; return undefined.
    return undefined;
  }

  /** Missing referenced-file URIs across all projects (for decorations). */
  collectMissingUris(): vscode.Uri[] {
    const out: vscode.Uri[] = [];
    for (const project of this.manager.getProjects()) {
      for (const obj of project.model.allOfIsa("PBXFileReference")) {
        if (!project.resolver.isFilesystemNode(obj)) {
          continue;
        }
        const resolved = project.resolver.resolve(obj.uuid);
        if (resolved !== null && !fs.existsSync(resolved)) {
          out.push(vscode.Uri.file(resolved));
        }
      }
    }
    for (const workspace of this.manager.getWorkspaces()) {
      for (const ref of workspace.data.allFileRefs()) {
        const resolved = workspace.data.resolveItem(ref.id, workspace.containerDir);
        if (resolved !== null && !fs.existsSync(resolved)) {
          out.push(vscode.Uri.file(resolved));
        }
      }
    }
    return out;
  }

  private wsChildNodes(workspace: LoadedWorkspace, items: readonly XcWorkspaceItem[]): PbxTreeNode[] {
    const nodes: PbxTreeNode[] = [];
    for (const item of items) {
      if (item.kind === "group") {
        nodes.push({ kind: "wsGroup", workspace, itemId: item.id } satisfies WsGroupTreeNode);
        continue;
      }
      const resolved = workspace.data.resolveItem(item.id, workspace.containerDir);
      const project =
        resolved !== null && resolved.toLowerCase().endsWith(".xcodeproj")
          ? this.manager.getProjectByXcodeprojPath(resolved)
          : undefined;
      if (project) {
        nodes.push({ kind: "project", project, wsRef: { workspace, itemId: item.id } });
      } else {
        const exists = resolved !== null ? fs.existsSync(resolved) : true;
        nodes.push({
          kind: "wsFileRef",
          workspace,
          itemId: item.id,
          resolvedPath: resolved,
          exists
        } satisfies WsFileRefTreeNode);
      }
    }
    return nodes;
  }

  private childNodes(project: LoadedProject, group: PbxObject): PbxTreeNode[] {
    const nodes: PbxTreeNode[] = [];
    for (const child of group.getStringArray("children")) {
      const obj = project.model.get(child.value);
      if (!obj) {
        continue; // broken reference — surfaced by the linter, not the tree
      }
      if (obj.isGroup()) {
        nodes.push({ kind: "group", project, uuid: obj.uuid } satisfies GroupTreeNode);
      } else {
        const resolvedPath = project.resolver.resolve(obj.uuid);
        const exists = resolvedPath !== null ? fs.existsSync(resolvedPath) : true;
        nodes.push({ kind: "file", project, uuid: obj.uuid, resolvedPath, exists } satisfies FileTreeNode);
      }
    }
    return nodes;
  }

  private workspaceItem(workspace: LoadedWorkspace): vscode.TreeItem {
    const item = new vscode.TreeItem(workspace.name, vscode.TreeItemCollapsibleState.Expanded);
    item.contextValue = "xcWorkspace";
    item.iconPath = new vscode.ThemeIcon("layers");
    item.description = workspace.error ? "error" : "Xcode Workspace";
    item.resourceUri = workspace.dataUri;
    item.tooltip = workspace.bundlePath;
    return item;
  }

  private wsGroupItem(node: WsGroupTreeNode): vscode.TreeItem {
    const wsItem = node.workspace.data.get(node.itemId);
    const label = wsItem ? wsItemDisplayName(wsItem) : node.itemId;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
    item.contextValue = "wsGroup";
    const resolved = node.workspace.data.resolveItem(node.itemId, node.workspace.containerDir);
    if (resolved !== null && fs.existsSync(resolved)) {
      item.iconPath = new vscode.ThemeIcon("folder");
      item.resourceUri = vscode.Uri.file(resolved);
    } else {
      item.iconPath = new vscode.ThemeIcon("folder-library");
      item.description = "group";
    }
    return item;
  }

  private wsFileRefItem(node: WsFileRefTreeNode): vscode.TreeItem {
    const wsItem = node.workspace.data.get(node.itemId);
    const label = wsItem ? wsItemDisplayName(wsItem) : node.itemId;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.contextValue = "wsFileRef";
    if (node.resolvedPath) {
      item.resourceUri = vscode.Uri.file(node.resolvedPath);
      item.tooltip = node.resolvedPath;
    } else if (wsItem) {
      item.tooltip = wsItem.location;
    }
    if (!node.exists && node.resolvedPath) {
      item.iconPath = new vscode.ThemeIcon("warning", new vscode.ThemeColor("list.warningForeground"));
      item.description = "missing";
    }
    if (node.resolvedPath && node.exists) {
      // pbx.openFile is directory-safe (asset catalogs open in a viewer,
      // other folders are a no-op).
      item.command = {
        command: "pbx.openFile",
        title: "Open",
        arguments: [node]
      };
    }
    return item;
  }

  private targetItem(node: TargetTreeNode): vscode.TreeItem {
    const info = targetInfo(node.project.model, node.uuid);
    const item = new vscode.TreeItem(info?.name ?? node.uuid, vscode.TreeItemCollapsibleState.Collapsed);
    item.contextValue = "pbxTarget";
    item.iconPath = new vscode.ThemeIcon(targetIcon(info?.productType));
    // e.g. "com.apple.product-type.application" -> "application"
    item.description = info?.productType?.split("product-type.").pop();
    item.tooltip = info?.productType;
    return item;
  }

  private buildPhaseItem(node: BuildPhaseTreeNode): vscode.TreeItem {
    const phase = buildPhasesOf(node.project.model, node.uuid).find((p) => p.uuid === node.uuid);
    const obj = node.project.model.get(node.uuid);
    const name = obj?.getString("name") ?? obj?.annotation ?? phase?.name ?? node.uuid;
    const fileCount = obj?.getStringArray("files").length ?? 0;
    const item = new vscode.TreeItem(
      name,
      fileCount > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    );
    item.contextValue = "pbxBuildPhase";
    item.iconPath = new vscode.ThemeIcon("list-ordered");
    item.description = String(fileCount);
    return item;
  }

  private packageItem(node: PackageTreeNode): vscode.TreeItem {
    const pkg = packageReferences(node.project.model).find((p) => p.uuid === node.uuid);
    const item = new vscode.TreeItem(pkg?.name ?? node.uuid, vscode.TreeItemCollapsibleState.None);
    item.contextValue = "pbxPackage";
    item.iconPath = new vscode.ThemeIcon("package");
    if (pkg?.relativePath !== undefined) {
      const resolved = path.resolve(node.project.projectRoot, pkg.relativePath);
      item.description = pkg.relativePath;
      item.tooltip = resolved;
      if (!fs.existsSync(resolved)) {
        item.iconPath = new vscode.ThemeIcon("warning", new vscode.ThemeColor("list.warningForeground"));
        item.description = `${pkg.relativePath} — missing`;
      }
    } else {
      item.description = requirementSummary(pkg?.requirement);
      item.tooltip = pkg?.repositoryURL;
    }
    return item;
  }

  private schemeItem(node: SchemeTreeNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.scheme.name, vscode.TreeItemCollapsibleState.None);
    item.contextValue = "xcScheme";
    item.iconPath = node.scheme.error
      ? new vscode.ThemeIcon("warning", new vscode.ThemeColor("list.warningForeground"))
      : new vscode.ThemeIcon("play");
    item.description = node.scheme.error ? "error" : "shared";
    item.resourceUri = node.scheme.uri;
    item.tooltip = node.scheme.uri.fsPath;
    item.command = {
      command: "pbx.openSchemeFile",
      title: "Open Scheme",
      arguments: [node]
    };
    return item;
  }

  private projectItem(project: LoadedProject, inWorkspace: boolean): vscode.TreeItem {
    const item = new vscode.TreeItem(
      project.name,
      inWorkspace ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded
    );
    item.contextValue = inWorkspace ? "pbxProjectInWorkspace" : "pbxProject";
    item.iconPath = new vscode.ThemeIcon("project");
    item.description = project.error ? "error" : "Xcode Project";
    item.resourceUri = project.pbxprojUri;
    item.tooltip = project.pbxprojUri.fsPath;
    return item;
  }

  private groupItem(project: LoadedProject, uuid: string): vscode.TreeItem {
    const obj = project.model.get(uuid);
    const label = obj?.displayName() ?? uuid;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
    const resolved = project.resolver.resolve(uuid);
    item.contextValue = resolved ? "pbxGroup" : "pbxGroupVirtual";
    if (obj?.isa === "PBXFileSystemSynchronizedRootGroup") {
      item.iconPath = new vscode.ThemeIcon("file-directory");
      item.description = "synchronized";
    } else if (resolved) {
      item.iconPath = new vscode.ThemeIcon("folder");
      item.resourceUri = vscode.Uri.file(resolved);
    } else {
      item.iconPath = new vscode.ThemeIcon("folder-library"); // virtual group
      item.description = "group";
    }
    return item;
  }

  private fileItem(node: FileTreeNode): vscode.TreeItem {
    const obj = node.project.model.get(node.uuid);
    const label = obj?.displayName() ?? node.uuid;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.contextValue = "pbxFile";
    if (node.resolvedPath) {
      item.resourceUri = vscode.Uri.file(node.resolvedPath);
      item.tooltip = node.resolvedPath;
    }
    if (!node.exists && node.resolvedPath) {
      item.iconPath = new vscode.ThemeIcon("warning", new vscode.ThemeColor("list.warningForeground"));
      item.description = "missing";
    }
    if (node.resolvedPath && node.exists) {
      item.command = {
        command: "pbx.openFile",
        title: "Open",
        arguments: [node]
      };
    }
    return item;
  }
}

/** Virtual section header ("Targets", "Package Dependencies", "Schemes"). */
function sectionItem(label: string, icon: string, count: number): vscode.TreeItem {
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
  item.contextValue = `pbxSection${label.replace(/\s/g, "")}`;
  item.iconPath = new vscode.ThemeIcon(icon);
  item.description = String(count);
  return item;
}

/** Codicon for a target's product type. */
function targetIcon(productType: string | undefined): string {
  if (!productType) {
    return "target";
  }
  if (productType.includes("test")) {
    return "beaker";
  }
  if (productType.includes("application")) {
    return "rocket";
  }
  if (productType.includes("framework") || productType.includes("library")) {
    return "library";
  }
  if (productType.includes("extension")) {
    return "extensions";
  }
  return "target";
}
