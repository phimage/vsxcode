<p align="center">
  <img src="https://raw.githubusercontent.com/phimage/vsxcode/main/media/icon.png" width="128" alt="Xcode Project Editor logo" />
</p>

<h1 align="center">Xcode Project Editor for VS Code</h1>

Inspect, browse and validate Xcode `.pbxproj` projects directly inside VS Code — on **Windows, Linux and macOS**, without ever opening Xcode.

> Primary use case: a Windows developer can browse an Xcode project, jump to its files, and instantly spot missing or broken references — no Mac required.

> **Disclaimer:** This is an unofficial, community project and is not affiliated with, endorsed by, or sponsored by Apple Inc. "Xcode" and related marks are trademarks of Apple Inc. Used here solely to describe compatibility with the `.pbxproj` project file format.

## Features

- **Syntax highlighting** for `.pbxproj` (UUIDs, comments, `isa` keywords, PBX/XC types, build settings, strings, sections) with bracket matching, section folding and a Document Symbols outline.
- **Round-trip parser** — a custom CST-based OpenStep property-list parser that preserves whitespace, comments and object ordering exactly. Serializing an unmodified project reproduces the original file byte-for-byte.
- **Project Navigator** — an Xcode-style tree in its own activity-bar view, discovered automatically from any `*.xcodeproj/project.pbxproj` in the workspace.
- **Open files** straight from the tree; **Reveal in File Explorer/Finder** for files and groups.
- **File operations** — create groups, add existing files, create new files (with target membership), rename, and remove (reference only or move-to-trash) — all writing clean, Xcode-style pbxproj.
- **Drag & drop** — reorder/reparent references inside the tree (move), or drop files from the Explorer / desktop to add references.
- **Linter + diagnostics** surfaced in the Problems panel, with red tree decorations for files that are referenced by the project but missing on disk.

## Screenshots

<p align="center">
  <img src="https://raw.githubusercontent.com/phimage/vsxcode/main/media/screenshot-project-navigator.png" alt="Project Navigator screenshot" width="800" />
</p>

Launch the extension (see [Development](#development)) against the bundled `test/fixtures/Sample.xcodeproj` to try it.

## Installation

- From source: see [Building](#building) / [Packaging](#packaging), then install the generated `.vsix` via **Extensions: Install from VSIX…**.

## Usage

1. Open a folder that contains an `.xcodeproj` bundle.
2. Open the **Xcode** view in the activity bar to browse the Project Navigator.
3. Click a file to open it; right-click for **Reveal in File Explorer**.
4. Open `project.pbxproj` for highlighting and an outline; issues appear in the **Problems** panel.

## Supported project types

- `project.pbxproj` (Xcode project files), including Xcode 16 `PBXFileSystemSynchronizedRootGroup` folders.
- `.xcworkspace` support is planned (see [Roadmap](#roadmap)).

## Commands

| Command | Description |
| --- | --- |
| `PBX: Refresh` | Re-scan the workspace, re-parse and re-lint. |
| `PBX: Validate Project` | Run the linter and report a summary. |
| `PBX: Open` | Open the selected file reference. |
| `PBX: Reveal in File Explorer` | Reveal the file/group on disk. |
| `PBX: Open project.pbxproj` | Open the raw project file. |
| `PBX: New Group` | Create a virtual group under the selection. |
| `PBX: New File…` | Create a file on disk and reference it (with target membership). |
| `PBX: Add Files…` | Add existing file(s)/folder(s) as references. |
| `PBX: Rename…` | Rename a group or file (renames on disk too). |
| `PBX: Remove from Project…` | Remove a reference, optionally moving the file to Trash. |

## Tree views

**Project Navigator** mirrors Xcode's navigator: the project's `mainGroup` hierarchy of groups and file references. File nodes use your file-icon theme; missing files are marked in red.

## Linter

| Diagnostic | Severity | Meaning |
| --- | --- | --- |
| `missing-file` | Error | A file reference resolves to a path that does not exist on disk. |
| `broken-reference` | Error | A reference (e.g. `fileRef`, `children`, `buildPhases`, `rootObject`) points to an unknown object. |
| `duplicate-uuid` | Error | The same object UUID is defined more than once. |
| `circular-group` | Error | A group transitively contains itself. |
| `duplicate-file` | Warning | Two file references resolve to the same path. |
| `broken-configuration` | Warning | The project or a target has a missing/empty `buildConfigurationList`. |

Diagnostics update on save, on `project.pbxproj` change, on **Refresh**, and via **Validate Project**.

## Development

```bash
npm install
npm run watch      # esbuild in watch mode
# Press F5 in VS Code to launch an Extension Development Host
```

The parser, model and linter are pure TypeScript (no `vscode` import) and covered by unit tests:

```bash
npm test           # vitest: round-trip, parser, path resolver, linter, editor mutations
npm run typecheck
npm run lint
```

## Building

```bash
npm run compile    # bundles src -> dist/extension.js via esbuild
```

## Packaging

```bash
npm run package    # produces vsxcode.vsix via @vscode/vsce
```

## Contributing

Issues and pull requests are welcome. Please run `npm run lint`, `npm run typecheck` and `npm test` before submitting.

## License

MIT

---

"Xcode" is a trademark of Apple Inc., registered in the U.S. and other countries. This project is not affiliated with or endorsed by Apple Inc.
