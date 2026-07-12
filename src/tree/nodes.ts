import { LoadedProject, LoadedScheme, LoadedWorkspace } from "../workspace/discovery";

export interface ProjectTreeNode {
  kind: "project";
  project: LoadedProject;
  /** Set when the project is shown under a workspace FileRef. */
  wsRef?: { workspace: LoadedWorkspace; itemId: string };
}

export interface GroupTreeNode {
  kind: "group";
  project: LoadedProject;
  uuid: string;
}

export interface FileTreeNode {
  kind: "file";
  project: LoadedProject;
  uuid: string;
  resolvedPath: string | null;
  exists: boolean;
}

export interface WorkspaceTreeNode {
  kind: "workspace";
  workspace: LoadedWorkspace;
}

/** A `<Group>` element of a workspace document. */
export interface WsGroupTreeNode {
  kind: "wsGroup";
  workspace: LoadedWorkspace;
  itemId: string;
}

/** A `<FileRef>` that is not a loadable Xcode project (loose file, folder, missing ref). */
export interface WsFileRefTreeNode {
  kind: "wsFileRef";
  workspace: LoadedWorkspace;
  itemId: string;
  resolvedPath: string | null;
  exists: boolean;
}

/** Virtual "Targets" section under a project node. */
export interface TargetsSectionTreeNode {
  kind: "targetsSection";
  project: LoadedProject;
}

export interface TargetTreeNode {
  kind: "target";
  project: LoadedProject;
  uuid: string;
}

export interface BuildPhaseTreeNode {
  kind: "buildPhase";
  project: LoadedProject;
  uuid: string;
}

/** Virtual "Package Dependencies" section under a project node. */
export interface PackagesSectionTreeNode {
  kind: "packagesSection";
  project: LoadedProject;
}

export interface PackageTreeNode {
  kind: "package";
  project: LoadedProject;
  uuid: string;
}

/** Virtual "Schemes" section under a project or workspace node. */
export interface SchemesSectionTreeNode {
  kind: "schemesSection";
  project?: LoadedProject;
  workspace?: LoadedWorkspace;
}

export interface SchemeTreeNode {
  kind: "scheme";
  scheme: LoadedScheme;
  /** Owning project, when the scheme lives in an `.xcodeproj` bundle. */
  project?: LoadedProject;
  workspace?: LoadedWorkspace;
}

export interface MessageTreeNode {
  kind: "message";
  message: string;
}

export type PbxTreeNode =
  | ProjectTreeNode
  | GroupTreeNode
  | FileTreeNode
  | WorkspaceTreeNode
  | WsGroupTreeNode
  | WsFileRefTreeNode
  | TargetsSectionTreeNode
  | TargetTreeNode
  | BuildPhaseTreeNode
  | PackagesSectionTreeNode
  | PackageTreeNode
  | SchemesSectionTreeNode
  | SchemeTreeNode
  | MessageTreeNode;

/** Nodes that belong to a `.pbxproj` document. */
export type PbxProjectNode = ProjectTreeNode | GroupTreeNode | FileTreeNode;

/** Nodes that belong to a `contents.xcworkspacedata` document. */
export type PbxWorkspaceNode = WorkspaceTreeNode | WsGroupTreeNode | WsFileRefTreeNode;
