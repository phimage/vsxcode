import { LoadedProject, LoadedWorkspace } from "../workspace/discovery";

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
  | MessageTreeNode;

/** Nodes that belong to a `.pbxproj` document. */
export type PbxProjectNode = ProjectTreeNode | GroupTreeNode | FileTreeNode;

/** Nodes that belong to a `contents.xcworkspacedata` document. */
export type PbxWorkspaceNode = WorkspaceTreeNode | WsGroupTreeNode | WsFileRefTreeNode;
