import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { ProjectEditor, ReferenceStyle } from "../edit/projectEditor";

/** Options governing how files are inserted into the project (Xcode's add-files sheet). */
export interface AddFilesOptions {
  /** Copy files into the destination group's folder when they live outside it. */
  copyIfNeeded: boolean;
  referenceStyle: ReferenceStyle;
  /** UUIDs of the targets the files should be added to. */
  targetUuids: string[];
}

export const ADD_FILES_SECTION = "xcodeProjectEditor.addFiles";

type TargetPolicy = "ask" | "all" | "none";

interface AddFilesSettings {
  showOptions: boolean;
  copyIfNeeded: boolean;
  referenceStyle: ReferenceStyle;
  addToTargets: TargetPolicy;
}

function readSettings(): AddFilesSettings {
  const config = vscode.workspace.getConfiguration(ADD_FILES_SECTION);
  return {
    showOptions: config.get<boolean>("showOptions", true),
    copyIfNeeded: config.get<boolean>("copyIfNeeded", false),
    referenceStyle: config.get<ReferenceStyle>("referenceStyle", "automatic"),
    addToTargets: config.get<TargetPolicy>("addToTargets", "all")
  };
}

async function targetsForPolicy(editor: ProjectEditor, policy: TargetPolicy): Promise<string[]> {
  const targets = editor.nativeTargets();
  if (targets.length === 0 || policy === "none") {
    return [];
  }
  if (policy === "all" || targets.length === 1) {
    return targets.map((t) => t.uuid);
  }
  const picks = await vscode.window.showQuickPick(
    targets.map((t) => ({ label: t.displayName(), uuid: t.uuid, picked: true })),
    { canPickMany: true, placeHolder: "Add to targets (Esc to add reference only)" }
  );
  return picks ? picks.map((p) => p.uuid) : [];
}

const STYLE_LABELS: Record<ReferenceStyle, { label: string; description: string }> = {
  automatic: { label: "Automatic", description: "match sibling files in the destination group" },
  group: { label: "Relative to Group", description: "sourceTree = <group>" },
  sourceRoot: { label: "Relative to Project", description: "sourceTree = SOURCE_ROOT" },
  absolute: { label: "Absolute Path", description: "sourceTree = <absolute>" }
};

interface OptionItem extends vscode.QuickPickItem {
  optionKind: "copy" | "style" | "target" | "remember";
  id: string;
}

function separator(label: string): vscode.QuickPickItem {
  return { label, kind: vscode.QuickPickItemKind.Separator };
}

/**
 * Xcode-like "Add files" options sheet built on a multi-select QuickPick:
 * copy-if-needed, reference style (single-choice, enforced), target
 * membership, and a "remember" item that persists the choices in settings.
 * Resolves to undefined when cancelled.
 */
async function promptOptions(
  editor: ProjectEditor,
  groupName: string,
  defaults: AddFilesSettings
): Promise<AddFilesOptions | undefined> {
  const targets = editor.nativeTargets();

  const copyItem: OptionItem = {
    optionKind: "copy",
    id: "copy",
    label: "Copy items if needed",
    description: "copy files that are outside the destination folder into it"
  };
  const styleItems: OptionItem[] = (Object.keys(STYLE_LABELS) as ReferenceStyle[]).map((style) => ({
    optionKind: "style",
    id: style,
    label: STYLE_LABELS[style].label,
    description: STYLE_LABELS[style].description
  }));
  const targetItems: OptionItem[] = targets.map((t) => ({
    optionKind: "target",
    id: t.uuid,
    label: t.displayName()
  }));
  const rememberItem: OptionItem = {
    optionKind: "remember",
    id: "remember",
    label: "Always use these options",
    description: "save as settings and don't show this dialog again"
  };

  const quickPick = vscode.window.createQuickPick<OptionItem | vscode.QuickPickItem>();
  quickPick.title = `Add files to “${groupName}”`;
  quickPick.placeholder = "Choose options, then press Enter to add (Esc to cancel)";
  quickPick.canSelectMany = true;
  quickPick.items = [
    separator("Destination"),
    copyItem,
    separator("Reference style"),
    ...styleItems,
    ...(targetItems.length > 0 ? [separator("Add to targets"), ...targetItems] : []),
    separator("Preferences"),
    rememberItem
  ];

  const initiallySelectedTargets =
    defaults.addToTargets === "none" ? [] : targetItems; // "ask" and "all" both preselect all
  let selection: OptionItem[] = [
    ...(defaults.copyIfNeeded ? [copyItem] : []),
    styleItems.find((s) => s.id === defaults.referenceStyle) ?? styleItems[0],
    ...initiallySelectedTargets
  ];
  quickPick.selectedItems = selection;

  return await new Promise<AddFilesOptions | undefined>((resolve) => {
    let done = false;

    // Enforce exactly one reference-style item selected.
    quickPick.onDidChangeSelection((selected) => {
      const items = selected.filter((i): i is OptionItem => "optionKind" in i);
      const styles = items.filter((i) => i.optionKind === "style");
      if (styles.length === 1) {
        selection = items;
        return;
      }
      const prevStyle = selection.find((i) => i.optionKind === "style");
      let keep: OptionItem | undefined;
      if (styles.length === 0) {
        keep = prevStyle; // don't allow deselecting the current style
      } else {
        keep = styles.find((s) => s !== prevStyle) ?? styles[0];
      }
      selection = [...items.filter((i) => i.optionKind !== "style"), ...(keep ? [keep] : [])];
      quickPick.selectedItems = selection;
    });

    quickPick.onDidAccept(() => {
      done = true;
      const items = quickPick.selectedItems.filter((i): i is OptionItem => "optionKind" in i);
      const style = (items.find((i) => i.optionKind === "style")?.id ?? "automatic") as ReferenceStyle;
      const targetUuids = items.filter((i) => i.optionKind === "target").map((i) => i.id);
      const options: AddFilesOptions = {
        copyIfNeeded: items.some((i) => i.optionKind === "copy"),
        referenceStyle: style,
        targetUuids
      };
      if (items.some((i) => i.optionKind === "remember")) {
        const config = vscode.workspace.getConfiguration(ADD_FILES_SECTION);
        void config.update("showOptions", false, vscode.ConfigurationTarget.Global);
        void config.update("copyIfNeeded", options.copyIfNeeded, vscode.ConfigurationTarget.Global);
        void config.update("referenceStyle", style, vscode.ConfigurationTarget.Global);
        void config.update(
          "addToTargets",
          targetUuids.length === 0 ? "none" : targetUuids.length === targets.length ? "all" : "ask",
          vscode.ConfigurationTarget.Global
        );
      }
      quickPick.hide();
      resolve(options);
    });
    quickPick.onDidHide(() => {
      quickPick.dispose();
      if (!done) {
        resolve(undefined);
      }
    });
    quickPick.show();
  });
}

/**
 * Resolves the add-files options: shows the Xcode-like options dialog unless
 * the user chose "always use these options" (then reads them from settings).
 * Returns undefined when the user cancelled.
 */
export async function resolveAddFilesOptions(
  editor: ProjectEditor,
  groupUuid: string
): Promise<AddFilesOptions | undefined> {
  const settings = readSettings();
  if (!settings.showOptions) {
    return {
      copyIfNeeded: settings.copyIfNeeded,
      referenceStyle: settings.referenceStyle,
      targetUuids: await targetsForPolicy(editor, settings.addToTargets)
    };
  }
  return promptOptions(editor, editor.displayName(groupUuid), settings);
}

/** Target selection for flows without the full dialog (e.g. New File…). */
export async function resolveTargets(editor: ProjectEditor): Promise<string[]> {
  return targetsForPolicy(editor, readSettings().addToTargets);
}

/**
 * Adds `absPaths` to `groupUuid` applying `options`: optionally copies each
 * file into the destination folder first, then adds the reference (with the
 * chosen reference style) and the build-phase memberships.
 */
export function performAdd(
  editor: ProjectEditor,
  groupUuid: string,
  absPaths: string[],
  options: AddFilesOptions
): string[] {
  const destDir = editor.resolvePath(groupUuid) ?? editor.projectRoot;
  const warnings: string[] = [];

  for (const original of absPaths) {
    let absPath = original;
    if (options.copyIfNeeded && !isInside(destDir, original)) {
      const copied = path.join(destDir, path.basename(original));
      try {
        if (fs.existsSync(copied)) {
          warnings.push(`${path.basename(original)} already exists in ${destDir}; referencing the existing file.`);
        } else {
          fs.mkdirSync(destDir, { recursive: true });
          fs.cpSync(original, copied, { recursive: true });
        }
        absPath = copied;
      } catch (err) {
        warnings.push(`Could not copy ${original}: ${(err as Error).message}`);
      }
    }
    const added = editor.addFileReference(groupUuid, absPath, options.referenceStyle);
    for (const targetUuid of options.targetUuids) {
      editor.addToBuildPhase(added.uuid, added.name, added.category, targetUuid);
    }
  }
  return warnings;
}

function isInside(dir: string, candidate: string): boolean {
  const rel = path.relative(dir, candidate);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}
