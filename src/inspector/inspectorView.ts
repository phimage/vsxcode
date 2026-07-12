import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { EditDeps } from "../commands/edit";
import { BuildConfigurationInfo, ProjectEditor, SOURCE_TREES } from "../edit/projectEditor";
import {
  PACKAGE_REQUIREMENT_KINDS,
  packageProductUses,
  packageReferences,
  targetInfo
} from "../model/queries";
import { SCHEME_CONFIG_ACTIONS, XcScheme } from "../schemes/scheme";
import { PbxTreeNode } from "../tree/nodes";
import {
  splitLocation,
  WS_LOCATION_PREFIXES,
  wsItemDisplayName,
  XcWorkspaceData
} from "../xcworkspace/workspaceData";

/** What the inspector is currently pointed at (survives tree refreshes). */
interface InspectedNode {
  /** The document an edit writes to: `.pbxproj`, `contents.xcworkspacedata` or `.xcscheme`. */
  documentUri: vscode.Uri;
  kind:
    | "project"
    | "group"
    | "file"
    | "workspace"
    | "wsGroup"
    | "wsFileRef"
    | "target"
    | "package"
    | "scheme";
  /** pbx object uuid, or workspace item id. */
  uuid?: string;
  /** Directory containing the `.xcworkspace` bundle (workspace kinds only). */
  containerDir?: string;
  /** Owning project's `.pbxproj` (scheme kind only, for configuration names). */
  ownerProjectUri?: vscode.Uri;
}

type WebviewMessage =
  | { type: "rename"; value: string }
  | { type: "setPath"; value: string }
  | { type: "setSourceTree"; value: string }
  | { type: "setMembership"; targetUuid: string; member: boolean }
  | { type: "setProjectString"; key: string; value: string }
  | { type: "setAttribute"; key: string; value: string }
  | { type: "setKnownRegions"; value: string }
  | { type: "setBuildSetting"; configUuid: string; key: string; value: string }
  | { type: "removeBuildSetting"; configUuid: string; key: string }
  | { type: "wsSetName"; value: string }
  | { type: "wsSetLocation"; prefix: string; path: string }
  | { type: "setTargetName"; value: string }
  | { type: "setPackageString"; key: "repositoryURL" | "relativePath"; value: string }
  | { type: "setPackageRequirement"; kind: string; value: string; value2: string }
  | { type: "schemeSetConfig"; action: string; value: string };

/** Keys editable as plain strings directly on the PBXProject object. */
const PROJECT_STRING_KEYS = new Set(["developmentRegion", "compatibilityVersion", "projectDirPath"]);

/**
 * Xcode-style inspector: a webview view showing a File/Group inspector
 * (identity, location, target membership) or the Project properties panel
 * (info + per-configuration build settings) depending on the tree selection.
 */
export class PbxInspectorViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = "xcodePbxInspector";

  private view: vscode.WebviewView | undefined;
  private current: InspectedNode | undefined;

  constructor(private readonly deps: EditDeps) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage((msg: WebviewMessage) => void this.handleMessage(msg));
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        this.render();
      }
    });
    this.render();
  }

  /** Points the inspector at a tree node (or clears it). */
  setNode(node: PbxTreeNode | undefined): void {
    if (
      !node ||
      node.kind === "message" ||
      node.kind === "targetsSection" ||
      node.kind === "packagesSection" ||
      node.kind === "schemesSection" ||
      node.kind === "buildPhase"
    ) {
      this.current = undefined;
    } else if (node.kind === "target" || node.kind === "package") {
      this.current = {
        documentUri: node.project.pbxprojUri,
        kind: node.kind,
        uuid: node.uuid
      };
    } else if (node.kind === "scheme") {
      this.current = {
        documentUri: node.scheme.uri,
        kind: "scheme",
        ownerProjectUri: node.project?.pbxprojUri
      };
    } else if (node.kind === "workspace" || node.kind === "wsGroup" || node.kind === "wsFileRef") {
      this.current = {
        documentUri: node.workspace.dataUri,
        kind: node.kind,
        uuid: "itemId" in node ? node.itemId : undefined,
        containerDir: node.workspace.containerDir
      };
    } else {
      this.current = {
        documentUri: node.project.pbxprojUri,
        kind: node.kind,
        uuid: "uuid" in node ? node.uuid : undefined
      };
    }
    this.render();
  }

  /** Re-renders after external changes (file watcher, other commands). */
  refreshView(): void {
    this.render();
  }

  private async handleMessage(msg: WebviewMessage): Promise<void> {
    const current = this.current;
    if (!current) {
      return;
    }
    if (current.kind === "workspace" || current.kind === "wsGroup" || current.kind === "wsFileRef") {
      await this.handleWorkspaceMessage(current, msg);
      return;
    }
    if (current.kind === "scheme") {
      await this.handleSchemeMessage(current, msg);
      return;
    }
    try {
      const editor = ProjectEditor.load(current.documentUri.fsPath);
      let changed = false;
      switch (msg.type) {
        case "rename":
          changed = await this.applyRename(editor, current, msg.value);
          break;
        case "setPath":
          changed = current.uuid ? editor.setPath(current.uuid, msg.value) : false;
          break;
        case "setSourceTree":
          changed = current.uuid ? editor.setSourceTree(current.uuid, msg.value) : false;
          break;
        case "setMembership":
          if (current.uuid) {
            editor.setTargetMembership(current.uuid, msg.targetUuid, msg.member);
            changed = true;
          }
          break;
        case "setProjectString":
          changed = PROJECT_STRING_KEYS.has(msg.key) ? editor.setProjectString(msg.key, msg.value) : false;
          break;
        case "setAttribute":
          changed = editor.setProjectAttribute(msg.key, msg.value);
          break;
        case "setKnownRegions":
          changed = editor.setKnownRegions(
            msg.value
              .split(",")
              .map((r) => r.trim())
              .filter((r) => r.length > 0)
          );
          break;
        case "setBuildSetting": {
          if (msg.key.trim() === "") {
            break;
          }
          const value = msg.value.includes("\n")
            ? msg.value.split("\n").map((v) => v.trim()).filter((v) => v.length > 0)
            : msg.value;
          changed = editor.setBuildSetting(msg.configUuid, msg.key.trim(), value);
          break;
        }
        case "removeBuildSetting":
          changed = editor.setBuildSetting(msg.configUuid, msg.key, null);
          break;
        case "setTargetName":
          changed = current.uuid ? editor.setTargetName(current.uuid, msg.value) : false;
          break;
        case "setPackageString":
          changed = current.uuid ? editor.setPackageString(current.uuid, msg.key, msg.value) : false;
          break;
        case "setPackageRequirement":
          changed =
            current.uuid && msg.value.trim() !== ""
              ? editor.setPackageRequirement(current.uuid, msg.kind, msg.value.trim(), msg.value2.trim() || undefined)
              : false;
          break;
      }
      if (changed) {
        await this.deps.saveText(current.documentUri, editor.serialize());
        await this.deps.refresh();
      }
    } catch (err) {
      void vscode.window.showErrorMessage(`Inspector edit failed: ${(err as Error).message}`);
    }
    this.render();
  }

  /** Applies an edit to a `contents.xcworkspacedata` document. */
  private async handleWorkspaceMessage(current: InspectedNode, msg: WebviewMessage): Promise<void> {
    try {
      const data = XcWorkspaceData.parse(fs.readFileSync(current.documentUri.fsPath, "utf8"));
      let changed = false;
      switch (msg.type) {
        case "wsSetName":
          changed = current.uuid ? data.setName(current.uuid, msg.value) : false;
          break;
        case "wsSetLocation":
          changed = current.uuid
            ? data.setLocation(current.uuid, `${msg.prefix}:${msg.path}`)
            : false;
          break;
      }
      if (changed) {
        await this.deps.saveText(current.documentUri, data.serialize());
        await this.deps.refresh();
      }
    } catch (err) {
      void vscode.window.showErrorMessage(`Inspector edit failed: ${(err as Error).message}`);
    }
    this.render();
  }

  /** Applies an edit to an `.xcscheme` document. */
  private async handleSchemeMessage(current: InspectedNode, msg: WebviewMessage): Promise<void> {
    try {
      const scheme = XcScheme.parse(fs.readFileSync(current.documentUri.fsPath, "utf8"));
      let changed = false;
      if (msg.type === "schemeSetConfig") {
        changed = scheme.setActionConfiguration(msg.action, msg.value);
      }
      if (changed) {
        await this.deps.saveText(current.documentUri, scheme.serialize());
        await this.deps.refresh();
      }
    } catch (err) {
      void vscode.window.showErrorMessage(`Inspector edit failed: ${(err as Error).message}`);
    }
    this.render();
  }

  /** Renames the reference and, like Xcode, the file on disk when possible. */
  private async applyRename(editor: ProjectEditor, node: InspectedNode, newName: string): Promise<boolean> {
    if (!node.uuid || newName.trim() === "" || newName === editor.displayName(node.uuid)) {
      return false;
    }
    const { oldPath, newPath } = editor.rename(node.uuid, newName.trim());
    if (oldPath && newPath && oldPath !== newPath && fs.existsSync(oldPath)) {
      try {
        await vscode.workspace.fs.rename(vscode.Uri.file(oldPath), vscode.Uri.file(newPath), {
          overwrite: false
        });
      } catch (err) {
        void vscode.window.showWarningMessage(
          `Renamed the reference, but could not rename the file on disk: ${(err as Error).message}`
        );
      }
    }
    return true;
  }

  // --- rendering -------------------------------------------------------------

  private render(): void {
    if (!this.view) {
      return;
    }
    this.view.webview.html = this.buildHtml();
  }

  private buildHtml(): string {
    const nonce = crypto.randomBytes(16).toString("hex");
    let body: string;
    let title = "Inspector";
    try {
      const rendered = this.renderBody();
      body = rendered.body;
      title = rendered.title;
    } catch (err) {
      body = `<p class="empty">Could not load project: ${esc((err as Error).message)}</p>`;
    }
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>${esc(title)}</title>
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 0 10px 12px; }
  h3 { margin: 12px 0 4px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-widget-border, transparent); padding-bottom: 3px; }
  .row { display: flex; align-items: center; gap: 6px; margin: 4px 0; }
  .row label { flex: 0 0 92px; font-size: 12px; color: var(--vscode-descriptionForeground); }
  input[type=text], textarea, select { flex: 1; min-width: 0; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; padding: 3px 5px; font-family: inherit; font-size: 12px; }
  textarea { resize: vertical; }
  input:focus, textarea:focus, select:focus { outline: 1px solid var(--vscode-focusBorder); }
  .readonly { opacity: 0.75; }
  .path-resolved { font-size: 11px; color: var(--vscode-descriptionForeground); word-break: break-all; margin: 2px 0 6px 98px; }
  .check { display: flex; align-items: center; gap: 6px; margin: 3px 0; font-size: 12px; }
  .empty { color: var(--vscode-descriptionForeground); font-style: italic; margin-top: 14px; }
  table { border-collapse: collapse; width: 100%; margin: 4px 0; }
  td { padding: 2px 4px 2px 0; vertical-align: top; }
  td.key { width: 45%; font-size: 12px; word-break: break-all; }
  button { background: var(--vscode-button-secondaryBackground, transparent); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); border: 1px solid var(--vscode-button-border, var(--vscode-widget-border, #8884)); border-radius: 2px; cursor: pointer; padding: 2px 7px; font-size: 11px; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground, #8882); }
  details { margin: 6px 0; }
  summary { cursor: pointer; font-weight: 600; font-size: 12px; margin: 4px 0; }
  .addrow input { margin-right: 4px; }
</style>
</head>
<body>
${body}
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  function post(msg) { vscode.postMessage(msg); }
  document.addEventListener("change", (e) => {
    const el = e.target;
    if (!el || !el.dataset || !el.dataset.msg) { return; }
    const d = el.dataset;
    switch (d.msg) {
      case "rename": post({ type: "rename", value: el.value }); break;
      case "setPath": post({ type: "setPath", value: el.value }); break;
      case "setSourceTree": post({ type: "setSourceTree", value: el.value }); break;
      case "setMembership": post({ type: "setMembership", targetUuid: d.target, member: el.checked }); break;
      case "setProjectString": post({ type: "setProjectString", key: d.key, value: el.value }); break;
      case "setAttribute": post({ type: "setAttribute", key: d.key, value: el.value }); break;
      case "setKnownRegions": post({ type: "setKnownRegions", value: el.value }); break;
      case "setBuildSetting": post({ type: "setBuildSetting", configUuid: d.config, key: d.key, value: el.value }); break;
      case "wsSetName": post({ type: "wsSetName", value: el.value }); break;
      case "wsSetLocation": {
        const prefix = document.getElementById("wsLocPrefix");
        const path = document.getElementById("wsLocPath");
        if (prefix && path) { post({ type: "wsSetLocation", prefix: prefix.value, path: path.value }); }
        break;
      }
      case "setTargetName": post({ type: "setTargetName", value: el.value }); break;
      case "setPackageString": post({ type: "setPackageString", key: d.key, value: el.value }); break;
      case "setPackageRequirement": {
        const kind = document.getElementById("pkgKind");
        const value = document.getElementById("pkgValue");
        const value2 = document.getElementById("pkgValue2");
        if (kind && value) {
          post({ type: "setPackageRequirement", kind: kind.value, value: value.value, value2: value2 ? value2.value : "" });
        }
        break;
      }
      case "schemeSetConfig": post({ type: "schemeSetConfig", action: d.action, value: el.value }); break;
    }
  });
  document.addEventListener("click", (e) => {
    const el = e.target;
    if (!el || !el.dataset || !el.dataset.action) { return; }
    const d = el.dataset;
    if (d.action === "removeSetting") {
      post({ type: "removeBuildSetting", configUuid: d.config, key: d.key });
    } else if (d.action === "addSetting") {
      const keyInput = document.getElementById("addKey-" + d.config);
      const valueInput = document.getElementById("addValue-" + d.config);
      if (keyInput && keyInput.value.trim()) {
        post({ type: "setBuildSetting", configUuid: d.config, key: keyInput.value, value: valueInput ? valueInput.value : "" });
      }
    }
  });
</script>
</body>
</html>`;
  }

  private renderBody(): { title: string; body: string } {
    if (!this.current) {
      return {
        title: "Inspector",
        body: `<p class="empty">Select a file, group or project in the Project Navigator to inspect it.</p>`
      };
    }
    if (
      this.current.kind === "workspace" ||
      this.current.kind === "wsGroup" ||
      this.current.kind === "wsFileRef"
    ) {
      return this.renderWorkspaceNode(this.current);
    }
    if (this.current.kind === "scheme") {
      return this.renderScheme(this.current);
    }
    const editor = ProjectEditor.load(this.current.documentUri.fsPath);
    if (this.current.kind === "project") {
      return { title: "Project", body: this.renderProject(editor) };
    }
    if (this.current.kind === "target") {
      return this.renderTarget(editor, this.current.uuid);
    }
    if (this.current.kind === "package") {
      return this.renderPackage(editor, this.current.uuid);
    }
    const uuid = this.current.uuid;
    const obj = uuid ? editor.model.get(uuid) : undefined;
    if (!uuid || !obj) {
      return { title: "Inspector", body: `<p class="empty">The selected item no longer exists in the project.</p>` };
    }

    const name = obj.displayName();
    const fileType = obj.getString("lastKnownFileType") ?? obj.getString("explicitFileType");
    const sourceTree = obj.getString("sourceTree") ?? "<group>";
    const refPath = obj.getString("path") ?? "";
    const resolved = editor.resolvePath(uuid);

    const trees: string[] = [...SOURCE_TREES];
    if (!trees.includes(sourceTree)) {
      trees.unshift(sourceTree);
    }
    const treeOptions = trees
      .map((t) => `<option value="${esc(t)}"${t === sourceTree ? " selected" : ""}>${esc(sourceTreeLabel(t))}</option>`)
      .join("");

    let body = `
<h3>Identity</h3>
<div class="row"><label>Name</label><input type="text" data-msg="rename" value="${esc(name)}"></div>`;
    if (fileType) {
      body += `\n<div class="row"><label>Type</label><input type="text" class="readonly" readonly value="${esc(fileType)}"></div>`;
    }
    body += `
<h3>Location</h3>
<div class="row"><label>Location</label><select data-msg="setSourceTree">${treeOptions}</select></div>
<div class="row"><label>Path</label><input type="text" data-msg="setPath" value="${esc(refPath)}"></div>
<div class="path-resolved">${resolved ? esc(resolved) : "not resolvable on the filesystem"}</div>`;

    if (this.current.kind === "file") {
      const memberships = editor.membershipsFor(uuid);
      body += `\n<h3>Target Membership</h3>`;
      if (memberships.length === 0) {
        body += `<p class="empty">This project has no targets.</p>`;
      }
      for (const m of memberships) {
        body += `\n<div class="check"><input type="checkbox" data-msg="setMembership" data-target="${esc(m.targetUuid)}"${m.member ? " checked" : ""}><span>${esc(m.targetName)}</span></div>`;
      }
    }
    return { title: name, body };
  }

  private renderProject(editor: ProjectEditor): string {
    const project = editor.projectObject();
    if (!project) {
      return `<p class="empty">No PBXProject object found.</p>`;
    }
    const stringRow = (label: string, key: string): string =>
      `<div class="row"><label>${esc(label)}</label><input type="text" data-msg="setProjectString" data-key="${esc(key)}" value="${esc(project.getString(key) ?? "")}"></div>`;
    const attrRow = (label: string, key: string): string =>
      `<div class="row"><label>${esc(label)}</label><input type="text" data-msg="setAttribute" data-key="${esc(key)}" value="${esc(editor.projectAttribute(key) ?? "")}"></div>`;

    let body = `
<h3>Project Document</h3>
${stringRow("Dev. Region", "developmentRegion")}
<div class="row"><label>Known Regions</label><input type="text" data-msg="setKnownRegions" value="${esc(editor.knownRegions().join(", "))}" placeholder="en, Base"></div>
${stringRow("Compatibility", "compatibilityVersion")}
${stringRow("Dir. Path", "projectDirPath")}
<h3>Attributes</h3>
${attrRow("Organization", "ORGANIZATIONNAME")}
${attrRow("Class Prefix", "CLASSPREFIX")}
<div class="row"><label>Last Upgrade</label><input type="text" class="readonly" readonly value="${esc(editor.projectAttribute("LastUpgradeCheck") ?? "")}"></div>
<h3>Build Configurations</h3>`;

    const configs = editor.buildConfigurationsOf(project);
    if (configs.length === 0) {
      body += `<p class="empty">No build configurations found.</p>`;
    }
    for (const config of configs) {
      body += this.renderConfiguration(config);
    }
    return body;
  }

  /** Inspector panels for workspace, workspace group and file-reference nodes. */
  private renderWorkspaceNode(current: InspectedNode): { title: string; body: string } {
    const data = XcWorkspaceData.parse(fs.readFileSync(current.documentUri.fsPath, "utf8"));
    const containerDir = current.containerDir ?? "";

    if (current.kind === "workspace") {
      const refs = data.allFileRefs();
      const projects = refs.filter((r) => {
        const p = data.resolveItem(r.id, containerDir);
        return p !== null && p.toLowerCase().endsWith(".xcodeproj");
      });
      let body = `
<h3>Workspace Document</h3>
<div class="row"><label>Version</label><input type="text" class="readonly" readonly value="${esc(data.version)}"></div>
<div class="row"><label>Path</label><input type="text" class="readonly" readonly value="${esc(current.documentUri.fsPath)}"></div>
<h3>Contents</h3>
<div class="row"><label>Projects</label><input type="text" class="readonly" readonly value="${projects.length}"></div>
<div class="row"><label>File Refs</label><input type="text" class="readonly" readonly value="${refs.length - projects.length}"></div>`;
      for (const ref of projects) {
        const resolved = data.resolveItem(ref.id, containerDir);
        body += `\n<div class="path-resolved">${esc(resolved ?? ref.location)}</div>`;
      }
      return { title: "Workspace", body };
    }

    const item = current.uuid ? data.get(current.uuid) : undefined;
    if (!item) {
      return { title: "Inspector", body: `<p class="empty">The selected item no longer exists in the workspace.</p>` };
    }
    const name = wsItemDisplayName(item);
    const { prefix, path: refPath } = splitLocation(item.location);
    const prefixes: string[] = [...WS_LOCATION_PREFIXES];
    if (!prefixes.includes(prefix)) {
      prefixes.unshift(prefix);
    }
    const prefixOptions = prefixes
      .map((p) => `<option value="${esc(p)}"${p === prefix ? " selected" : ""}>${esc(wsPrefixLabel(p))}</option>`)
      .join("");
    const resolved = data.resolveItem(item.id, containerDir);

    let body = `\n<h3>Identity</h3>`;
    if (item.kind === "group") {
      body += `\n<div class="row"><label>Name</label><input type="text" data-msg="wsSetName" value="${esc(item.name ?? "")}" placeholder="${esc(name)}"></div>`;
    } else {
      body += `\n<div class="row"><label>Name</label><input type="text" class="readonly" readonly value="${esc(name)}"></div>`;
    }
    body += `
<h3>Location</h3>
<div class="row"><label>Location</label><select id="wsLocPrefix" data-msg="wsSetLocation">${prefixOptions}</select></div>
<div class="row"><label>Path</label><input type="text" id="wsLocPath" data-msg="wsSetLocation" value="${esc(refPath)}"></div>
<div class="path-resolved">${resolved ? esc(resolved) : "not resolvable on the filesystem"}</div>`;
    return { title: name, body };
  }

  /** Xcode-style target inspector: identity, dependencies, build settings. */
  private renderTarget(editor: ProjectEditor, uuid: string | undefined): { title: string; body: string } {
    const info = uuid ? targetInfo(editor.model, uuid) : undefined;
    const target = uuid ? editor.model.get(uuid) : undefined;
    if (!info || !target) {
      return { title: "Target", body: `<p class="empty">The selected target no longer exists.</p>` };
    }
    let body = `
<h3>Identity</h3>
<div class="row"><label>Name</label><input type="text" data-msg="setTargetName" value="${esc(info.name)}"></div>
<div class="row"><label>Type</label><input type="text" class="readonly" readonly value="${esc(info.isa)}"></div>`;
    if (info.productType) {
      body += `\n<div class="row"><label>Product Type</label><input type="text" class="readonly" readonly value="${esc(info.productType)}"></div>`;
    }
    if (info.productName) {
      body += `\n<div class="row"><label>Product Name</label><input type="text" class="readonly" readonly value="${esc(info.productName)}"></div>`;
    }
    body += `\n<h3>Dependencies</h3>`;
    if (info.dependencyNames.length === 0) {
      body += `<p class="empty">No target dependencies.</p>`;
    }
    for (const dep of info.dependencyNames) {
      body += `\n<div class="check"><span>${esc(dep)}</span></div>`;
    }
    body += `\n<h3>Build Configurations</h3>`;
    const configs = editor.buildConfigurationsOf(target);
    if (configs.length === 0) {
      body += `<p class="empty">No build configurations found.</p>`;
    }
    for (const config of configs) {
      body += this.renderConfiguration(config);
    }
    return { title: info.name, body };
  }

  /** Swift package dependency inspector (remote: URL + requirement; local: path). */
  private renderPackage(editor: ProjectEditor, uuid: string | undefined): { title: string; body: string } {
    const pkg = uuid ? packageReferences(editor.model).find((p) => p.uuid === uuid) : undefined;
    if (!pkg || !uuid) {
      return { title: "Package", body: `<p class="empty">The selected package no longer exists.</p>` };
    }
    let body = `\n<h3>Identity</h3>
<div class="row"><label>Name</label><input type="text" class="readonly" readonly value="${esc(pkg.name)}"></div>`;

    if (pkg.relativePath !== undefined) {
      body += `
<h3>Location</h3>
<div class="row"><label>Path</label><input type="text" data-msg="setPackageString" data-key="relativePath" value="${esc(pkg.relativePath)}"></div>`;
    } else {
      const req = pkg.requirement;
      const kinds: string[] = [...PACKAGE_REQUIREMENT_KINDS];
      if (req && !kinds.includes(req.kind)) {
        kinds.unshift(req.kind);
      }
      const kindOptions = kinds
        .map((k) => `<option value="${esc(k)}"${k === req?.kind ? " selected" : ""}>${esc(requirementKindLabel(k))}</option>`)
        .join("");
      body += `
<h3>Location</h3>
<div class="row"><label>Repository</label><input type="text" data-msg="setPackageString" data-key="repositoryURL" value="${esc(pkg.repositoryURL ?? "")}"></div>
<h3>Version Requirement</h3>
<div class="row"><label>Rule</label><select id="pkgKind" data-msg="setPackageRequirement">${kindOptions}</select></div>
<div class="row"><label>Value</label><input type="text" id="pkgValue" data-msg="setPackageRequirement" value="${esc(req?.value ?? "")}" placeholder="version / branch / revision"></div>
<div class="row"><label>Up To</label><input type="text" id="pkgValue2" data-msg="setPackageRequirement" value="${esc(req?.value2 ?? "")}" placeholder="max version (range only)"></div>`;
    }

    const uses = packageProductUses(editor.model, uuid);
    body += `\n<h3>Used By</h3>`;
    if (uses.length === 0) {
      body += `<p class="empty">No target uses products of this package.</p>`;
    }
    for (const use of uses) {
      body += `\n<div class="check"><span>${esc(use.targetName)} — ${esc(use.productName)}</span></div>`;
    }
    return { title: pkg.name, body };
  }

  /** Scheme inspector: buildable targets + per-action build configuration. */
  private renderScheme(current: InspectedNode): { title: string; body: string } {
    const scheme = XcScheme.parse(fs.readFileSync(current.documentUri.fsPath, "utf8"));
    const name = path.basename(current.documentUri.fsPath).replace(/\.xcscheme$/i, "");

    // Configuration names from the owning project, for the selects.
    let configNames: string[] = [];
    if (current.ownerProjectUri) {
      try {
        const editor = ProjectEditor.load(current.ownerProjectUri.fsPath);
        const project = editor.projectObject();
        configNames = project ? editor.buildConfigurationsOf(project).map((c) => c.name) : [];
      } catch {
        configNames = [];
      }
    }

    let body = `
<h3>Scheme</h3>
<div class="row"><label>Name</label><input type="text" class="readonly" readonly value="${esc(name)}"></div>
<div class="row"><label>Version</label><input type="text" class="readonly" readonly value="${esc(scheme.version ?? "")}"></div>
<h3>Build Targets</h3>`;
    const refs = scheme.buildableReferences();
    if (refs.length === 0) {
      body += `<p class="empty">No buildable references.</p>`;
    }
    for (const ref of refs) {
      body += `\n<div class="check"><span>${esc(ref.blueprintName)} — ${esc(ref.referencedContainer)}</span></div>`;
    }

    body += `\n<h3>Build Configuration per Action</h3>`;
    const actions = new Map(scheme.actionConfigurations().map((a) => [a.action, a.buildConfiguration]));
    for (const action of SCHEME_CONFIG_ACTIONS) {
      const value = actions.get(action);
      if (value === undefined) {
        continue;
      }
      const label = action.replace(/Action$/, "");
      if (configNames.length > 0) {
        const names = configNames.includes(value) ? configNames : [value, ...configNames];
        const options = names
          .map((n) => `<option value="${esc(n)}"${n === value ? " selected" : ""}>${esc(n)}</option>`)
          .join("");
        body += `\n<div class="row"><label>${esc(label)}</label><select data-msg="schemeSetConfig" data-action="${esc(action)}">${options}</select></div>`;
      } else {
        body += `\n<div class="row"><label>${esc(label)}</label><input type="text" data-msg="schemeSetConfig" data-action="${esc(action)}" value="${esc(value)}"></div>`;
      }
    }
    return { title: name, body };
  }

  private renderConfiguration(config: BuildConfigurationInfo): string {
    let rows = "";
    for (const setting of config.settings) {
      const isArray = Array.isArray(setting.value);
      const raw = isArray ? (setting.value as string[]).join("\n") : (setting.value as string);
      const input = isArray
        ? `<textarea rows="${Math.min(6, (setting.value as string[]).length)}" data-msg="setBuildSetting" data-config="${esc(config.uuid)}" data-key="${esc(setting.key)}">${esc(raw)}</textarea>`
        : `<input type="text" data-msg="setBuildSetting" data-config="${esc(config.uuid)}" data-key="${esc(setting.key)}" value="${esc(raw)}">`;
      rows += `
<tr>
  <td class="key" title="${esc(setting.key)}">${esc(setting.key)}</td>
  <td><div class="row" style="margin:0">${input}<button data-action="removeSetting" data-config="${esc(config.uuid)}" data-key="${esc(setting.key)}" title="Remove setting">✕</button></div></td>
</tr>`;
    }
    return `
<details open>
<summary>${esc(config.name)}</summary>
<table>${rows}</table>
<div class="row addrow">
  <input type="text" id="addKey-${esc(config.uuid)}" placeholder="SETTING_NAME">
  <input type="text" id="addValue-${esc(config.uuid)}" placeholder="value">
  <button data-action="addSetting" data-config="${esc(config.uuid)}">Add</button>
</div>
</details>`;
  }
}

function requirementKindLabel(kind: string): string {
  switch (kind) {
    case "upToNextMajorVersion":
      return "Up to Next Major Version";
    case "upToNextMinorVersion":
      return "Up to Next Minor Version";
    case "exactVersion":
      return "Exact Version";
    case "versionRange":
      return "Version Range";
    case "branch":
      return "Branch";
    case "revision":
      return "Commit";
    default:
      return kind;
  }
}

function wsPrefixLabel(prefix: string): string {
  switch (prefix) {
    case "group":
      return "Relative to Group";
    case "container":
      return "Relative to Workspace";
    case "absolute":
      return "Absolute Path";
    case "developer":
      return "Relative to Developer Directory";
    case "self":
      return "Relative to Workspace Bundle";
    default:
      return prefix;
  }
}

function sourceTreeLabel(tree: string): string {
  switch (tree) {
    case "<group>":
      return "Relative to Group";
    case "SOURCE_ROOT":
      return "Relative to Project";
    case "<absolute>":
      return "Absolute Path";
    case "BUILT_PRODUCTS_DIR":
      return "Relative to Build Products";
    case "SDKROOT":
      return "Relative to SDK";
    case "DEVELOPER_DIR":
      return "Relative to Developer Directory";
    default:
      return tree;
  }
}

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
