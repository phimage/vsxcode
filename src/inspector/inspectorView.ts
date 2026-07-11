import * as crypto from "crypto";
import * as fs from "fs";
import * as vscode from "vscode";
import { EditDeps } from "../commands/edit";
import { BuildConfigurationInfo, ProjectEditor, SOURCE_TREES } from "../edit/projectEditor";
import { PbxTreeNode } from "../tree/nodes";

/** What the inspector is currently pointed at (survives tree refreshes). */
interface InspectedNode {
  projectUri: vscode.Uri;
  kind: "project" | "group" | "file";
  uuid?: string;
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
  | { type: "removeBuildSetting"; configUuid: string; key: string };

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
    if (!node || node.kind === "message") {
      this.current = undefined;
    } else {
      this.current = {
        projectUri: node.project.pbxprojUri,
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
    try {
      const editor = ProjectEditor.load(current.projectUri.fsPath);
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
      }
      if (changed) {
        await this.deps.saveText(current.projectUri, editor.serialize());
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
    const editor = ProjectEditor.load(this.current.projectUri.fsPath);
    if (this.current.kind === "project") {
      return { title: "Project", body: this.renderProject(editor) };
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
