import { findAll, firstChild, getAttr, setAttr, XmlDoc } from "../xml/xmlDoc";

/**
 * Typed accessors over an `.xcscheme` document. Pure (no `vscode` import).
 * Shared schemes live in `<bundle>/xcshareddata/xcschemes/<Name>.xcscheme`
 * inside `.xcodeproj` and `.xcworkspace` bundles.
 */

/** Scheme actions carrying a `buildConfiguration` attribute, in Xcode order. */
export const SCHEME_CONFIG_ACTIONS = [
  "TestAction",
  "LaunchAction",
  "ProfileAction",
  "AnalyzeAction",
  "ArchiveAction"
] as const;

export type SchemeConfigAction = (typeof SCHEME_CONFIG_ACTIONS)[number];

export interface SchemeActionConfig {
  action: SchemeConfigAction;
  buildConfiguration: string;
}

export interface BuildableReferenceInfo {
  /** Target name, e.g. `Sample`. */
  blueprintName: string;
  /** Product name, e.g. `Sample.app`. */
  buildableName: string;
  /** Target UUID in the referenced container's pbxproj. */
  blueprintIdentifier: string;
  /** e.g. `container:Sample.xcodeproj`. */
  referencedContainer: string;
}

export class XcScheme {
  private constructor(readonly doc: XmlDoc) {}

  static parse(text: string): XcScheme {
    const doc = XmlDoc.parse(text);
    if (doc.root.name !== "Scheme") {
      throw new Error(`Not a scheme document: root element is <${doc.root.name}>`);
    }
    return new XcScheme(doc);
  }

  serialize(): string {
    return this.doc.serialize();
  }

  get lastUpgradeVersion(): string | undefined {
    return getAttr(this.doc.root, "LastUpgradeVersion");
  }

  get version(): string | undefined {
    return getAttr(this.doc.root, "version");
  }

  /** Per-action build configuration, for the actions present in the document. */
  actionConfigurations(): SchemeActionConfig[] {
    const out: SchemeActionConfig[] = [];
    for (const action of SCHEME_CONFIG_ACTIONS) {
      const el = firstChild(this.doc.root, action);
      const buildConfiguration = el ? getAttr(el, "buildConfiguration") : undefined;
      if (el && buildConfiguration !== undefined) {
        out.push({ action, buildConfiguration });
      }
    }
    return out;
  }

  /** Updates one action's `buildConfiguration`; false when unchanged/absent. */
  setActionConfiguration(action: string, buildConfiguration: string): boolean {
    if (!(SCHEME_CONFIG_ACTIONS as readonly string[]).includes(action)) {
      return false;
    }
    const el = firstChild(this.doc.root, action);
    if (!el || getAttr(el, "buildConfiguration") === buildConfiguration) {
      return false;
    }
    setAttr(el, "buildConfiguration", buildConfiguration);
    return true;
  }

  /** Every `BuildableReference` in the scheme (build entries, testables, …), deduplicated. */
  buildableReferences(): BuildableReferenceInfo[] {
    const out: BuildableReferenceInfo[] = [];
    const seen = new Set<string>();
    for (const el of findAll(this.doc.root, "BuildableReference")) {
      const info: BuildableReferenceInfo = {
        blueprintName: getAttr(el, "BlueprintName") ?? "",
        buildableName: getAttr(el, "BuildableName") ?? "",
        blueprintIdentifier: getAttr(el, "BlueprintIdentifier") ?? "",
        referencedContainer: getAttr(el, "ReferencedContainer") ?? ""
      };
      const key = `${info.blueprintIdentifier}|${info.referencedContainer}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(info);
      }
    }
    return out;
  }
}
