import { describe, expect, it } from "vitest";
import { findAll, firstChild, getAttr, makeElement, setAttr, XmlDoc } from "../../src/xml/xmlDoc";
import { readFixture } from "../helpers";

const FIXTURE = "Sample.xcodeproj/xcshareddata/xcschemes/Sample.xcscheme";

describe("XmlDoc.parse", () => {
  it("parses the scheme fixture into an element tree", () => {
    const doc = XmlDoc.parse(readFixture(FIXTURE));
    expect(doc.root.name).toBe("Scheme");
    expect(getAttr(doc.root, "version")).toBe("1.7");
    expect(doc.root.children.map((c) => c.name)).toEqual([
      "BuildAction",
      "TestAction",
      "LaunchAction",
      "ProfileAction",
      "AnalyzeAction",
      "ArchiveAction"
    ]);
    const refs = findAll(doc.root, "BuildableReference");
    expect(refs).toHaveLength(2);
    expect(getAttr(refs[0], "BlueprintName")).toBe("Sample");
  });

  it("accepts self-closing tags and decodes entities", () => {
    const doc = XmlDoc.parse('<Root a="x &amp; y"><Leaf b="&quot;q&quot;"/></Root>');
    expect(getAttr(doc.root, "a")).toBe("x & y");
    expect(getAttr(firstChild(doc.root, "Leaf")!, "b")).toBe('"q"');
  });

  it("rejects malformed documents", () => {
    expect(() => XmlDoc.parse("<A><B></A>")).toThrow(/Mismatched/);
    expect(() => XmlDoc.parse("<A></A><B></B>")).toThrow(/Multiple root/);
    expect(() => XmlDoc.parse("<A><B></B>")).toThrow(/Unclosed/);
    expect(() => XmlDoc.parse("plain text")).toThrow(/No root/);
  });
});

describe("XmlDoc.serialize", () => {
  it("round-trips the Xcode-written scheme fixture byte-for-byte", () => {
    const text = readFixture(FIXTURE);
    expect(XmlDoc.parse(text).serialize()).toBe(text);
  });

  it("escapes attribute values and preserves attribute order", () => {
    const root = makeElement("Root", [["b", "2"], ["a", "1 & <2>"]]);
    const text = new XmlDoc(root).serialize();
    expect(text).toContain('b = "2"');
    expect(text.indexOf('b = "2"')).toBeLessThan(text.indexOf('a = "1 &amp; &lt;2&gt;"'));
  });

  it("setAttr updates in place and appends new attributes", () => {
    const el = makeElement("E", [["x", "1"]]);
    setAttr(el, "x", "2");
    setAttr(el, "y", "3");
    expect(el.attrs).toEqual([["x", "2"], ["y", "3"]]);
  });
});
