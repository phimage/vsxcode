import * as fs from "fs";
import * as vscode from "vscode";
import { PbxObject } from "../model/types";
import { XcWorkspaceItem, wsItemDisplayName } from "../xcworkspace/workspaceData";
import { LoadedProject, LoadedWorkspace, ProjectManager } from "../workspace/discovery";
import { FileTreeNode, GroupTreeNode, PbxTreeNode, WsFileRefTreeNode, WsGroupTreeNode } from "./nodes";

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
        return this.wsChildNodes(workspace, workspace.data.items);
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
        return main ? this.childNodes(project, main) : [];
      }
      case "group": {
        const obj = element.project.model.get(element.uuid);
        return obj ? this.childNodes(element.project, obj) : [];
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
