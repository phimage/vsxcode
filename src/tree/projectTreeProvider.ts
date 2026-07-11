import * as fs from "fs";
import * as vscode from "vscode";
import { PbxObject } from "../model/types";
import { LoadedProject, ProjectManager } from "../workspace/discovery";
import { FileTreeNode, GroupTreeNode, PbxTreeNode } from "./nodes";

export class ProjectTreeProvider implements vscode.TreeDataProvider<PbxTreeNode> {
  private readonly emitter = new vscode.EventEmitter<PbxTreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly manager: ProjectManager) {}

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(node: PbxTreeNode): vscode.TreeItem {
    switch (node.kind) {
      case "project":
        return this.projectItem(node.project);
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
      return this.manager.getProjects().map((project) => ({ kind: "project", project }));
    }
    switch (element.kind) {
      case "project": {
        const { project } = element;
        if (project.error) {
          return [{ kind: "message", project, message: project.error }];
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
    return out;
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

  private projectItem(project: LoadedProject): vscode.TreeItem {
    const item = new vscode.TreeItem(project.name, vscode.TreeItemCollapsibleState.Expanded);
    item.contextValue = "pbxProject";
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
    item.contextValue = "pbxGroup";
    const resolved = project.resolver.resolve(uuid);
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
      item.iconPath = new vscode.ThemeIcon("error", new vscode.ThemeColor("list.errorForeground"));
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
