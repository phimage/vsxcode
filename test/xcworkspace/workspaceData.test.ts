import * as path from "path";
import { describe, expect, it } from "vitest";
import {
  isInsideXcodeproj,
  locationFor,
  resolveLocation,
  splitLocation,
  wsItemDisplayName,
  XcWorkspaceData,
  XcGroup
} from "../../src/xcworkspace/workspaceData";
import { fixturesDir, readFixture } from "../helpers";

const FIXTURE = "Sample.xcworkspace/contents.xcworkspacedata";

describe("XcWorkspaceData.parse", () => {
  it("parses file refs and groups from the fixture", () => {
    const data = XcWorkspaceData.parse(readFixture(FIXTURE));
    expect(data.version).toBe("1.0");
    expect(data.items).toHaveLength(2);

    const [ref, group] = data.items;
    expect(ref.kind).toBe("fileRef");
    expect(ref.location).toBe("group:Sample.xcodeproj");

    expect(group.kind).toBe("group");
    const g = group as XcGroup;
    expect(g.name).toBe("Shared Sources");
    expect(g.location).toBe("container:Sources");
    expect(g.children).toHaveLength(2);
    expect(g.children[0].location).toBe("group:AppDelegate.swift");
  });

  it("parses self-closing and compact single-line documents", () => {
    const data = XcWorkspaceData.parse(
      '<?xml version="1.0" encoding="UTF-8"?><Workspace version="1.0"><FileRef location="group:A.xcodeproj"/><Group location="group:G"/></Workspace>'
    );
    expect(data.items).toHaveLength(2);
    expect(data.items[1].kind).toBe("group");
  });

  it("decodes XML entities in attribute values", () => {
    const data = XcWorkspaceData.parse(
      '<Workspace version="1.0"><FileRef location="group:A &amp; B&#x2F;C.xcodeproj"/></Workspace>'
    );
    expect(data.items[0].location).toBe("group:A & B/C.xcodeproj");
  });

  it("rejects non-workspace documents", () => {
    expect(() => XcWorkspaceData.parse("<plist></plist>")).toThrow();
    expect(() => XcWorkspaceData.parse("")).toThrow(/Workspace/);
  });
});

describe("XcWorkspaceData.serialize", () => {
  it("round-trips the fixture byte-for-byte (Xcode formatting)", () => {
    const text = readFixture(FIXTURE);
    expect(XcWorkspaceData.parse(text).serialize()).toBe(text);
  });

  it("escapes XML special characters", () => {
    const data = XcWorkspaceData.empty();
    data.addGroup(null, "group:A & B", 'Say "hi" <now>');
    const text = data.serialize();
    expect(text).toContain('location = "group:A &amp; B"');
    expect(text).toContain('name = "Say &quot;hi&quot; &lt;now&gt;"');
    const reparsed = XcWorkspaceData.parse(text);
    expect((reparsed.items[0] as XcGroup).name).toBe('Say "hi" <now>');
  });
});

describe("location resolution", () => {
  const container = path.join(fixturesDir);

  it("splits locations into prefix and path", () => {
    expect(splitLocation("group:App/App.xcodeproj")).toEqual({ prefix: "group", path: "App/App.xcodeproj" });
    expect(splitLocation("container:")).toEqual({ prefix: "container", path: "" });
  });

  it("resolves group:, container: and absolute: prefixes", () => {
    expect(resolveLocation("group:X", "/base/g", "/base")).toBe(path.resolve("/base/g/X"));
    expect(resolveLocation("container:X", "/base/g", "/base")).toBe(path.resolve("/base/X"));
    expect(resolveLocation("absolute:/tmp/X", "/base/g", "/base")).toBe(path.resolve("/tmp/X"));
    expect(resolveLocation("developer:usr/bin", "/base/g", "/base")).toBeNull();
    expect(resolveLocation("self:", "/base/g", "/base")).toBeNull();
  });

  it("resolves nested items through their group chain", () => {
    const data = XcWorkspaceData.parse(readFixture(FIXTURE));
    const [ref, group] = data.items;
    expect(data.resolveItem(ref.id, container)).toBe(path.join(container, "Sample.xcodeproj"));

    const g = group as XcGroup;
    expect(data.resolveItem(g.id, container)).toBe(path.join(container, "Sources"));
    // group: child resolves relative to the parent group's directory
    expect(data.resolveItem(g.children[0].id, container)).toBe(
      path.join(container, "Sources", "AppDelegate.swift")
    );
    expect(data.resolveItem(g.children[1].id, container)).toBe(path.resolve("/tmp/External.md"));
  });
});

describe("edits", () => {
  it("adds, renames and removes items", () => {
    const data = XcWorkspaceData.parse(readFixture(FIXTURE));
    const group = data.items[1] as XcGroup;

    const added = data.addFileRef(group.id, "group:MainView.swift");
    expect(group.children.at(-1)).toBe(added);
    expect(data.parentOf(added.id)).toBe(group);

    expect(data.setName(group.id, "Renamed")).toBe(true);
    expect(group.name).toBe("Renamed");
    expect(data.setName(group.id, "Renamed")).toBe(false); // unchanged
    expect(data.setName(added.id, "X")).toBe(false); // not a group

    expect(data.setLocation(added.id, "container:Sources/MainView.swift")).toBe(true);
    expect(data.remove(added.id)).toBe(true);
    expect(data.remove(added.id)).toBe(false);
    expect(group.children).toHaveLength(2);
  });

  it("adds top-level groups and serializes them", () => {
    const data = XcWorkspaceData.empty();
    data.addFileRef(null, "group:App.xcodeproj");
    data.addGroup(null, "container:", "Docs");
    const reparsed = XcWorkspaceData.parse(data.serialize());
    expect(reparsed.items.map((i) => i.kind)).toEqual(["fileRef", "group"]);
  });

  it("collects project file refs recursively", () => {
    const data = XcWorkspaceData.parse(readFixture(FIXTURE));
    expect(data.allFileRefs().map((r) => r.location)).toEqual([
      "group:Sample.xcodeproj",
      "group:AppDelegate.swift",
      "absolute:/tmp/External.md"
    ]);
  });
});

describe("helpers", () => {
  it("derives display names", () => {
    const data = XcWorkspaceData.parse(readFixture(FIXTURE));
    expect(wsItemDisplayName(data.items[0])).toBe("Sample.xcodeproj");
    expect(wsItemDisplayName(data.items[1])).toBe("Shared Sources");
    const unnamed = data.addGroup(null, "group:Some/Dir");
    expect(wsItemDisplayName(unnamed)).toBe("Dir");
  });

  it("prefers group-relative locations for new refs", () => {
    expect(locationFor("/base/App/App.xcodeproj", "/base")).toBe("group:App/App.xcodeproj");
    expect(locationFor("/elsewhere/App.xcodeproj", "/base")).toBe("group:../elsewhere/App.xcodeproj");
  });

  it("detects the implicit workspace inside .xcodeproj bundles", () => {
    expect(isInsideXcodeproj("/a/Foo.xcodeproj/project.xcworkspace/contents.xcworkspacedata")).toBe(true);
    expect(isInsideXcodeproj("/a/Foo.xcworkspace/contents.xcworkspacedata")).toBe(false);
  });
});
