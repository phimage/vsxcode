import { LoadedProject } from "../workspace/discovery";

export interface ProjectTreeNode {
  kind: "project";
  project: LoadedProject;
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

export interface MessageTreeNode {
  kind: "message";
  project: LoadedProject;
  message: string;
}

export type PbxTreeNode = ProjectTreeNode | GroupTreeNode | FileTreeNode | MessageTreeNode;
