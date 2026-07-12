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
- **Xcode workspaces** — `.xcworkspace` bundles become tree roots with their referenced projects nested inside (even projects outside the opened folder); browse, edit and inspect workspace groups and file references.
- **Targets** — a *Targets* section under each project lists targets with their build phases and files; the inspector edits the target name and per-configuration build settings, and shows dependencies.
- **Swift Packages** — a *Package Dependencies* section shows remote packages (with their version rule) and local packages; the inspector edits the repository URL and version requirement (up-to-next-major, exact, range, branch, revision).
- **Schemes** — shared `.xcscheme` files (`xcshareddata/xcschemes`) are listed under their project or workspace; the inspector shows buildable targets and edits each action's build configuration, preserving Xcode's XML formatting byte-for-byte.
- **Open files** straight from the tree; **Reveal in File Explorer/Finder** for files and groups.
- **File operations** — create groups, add existing files, create new files (with target membership), rename, and remove (reference only or move-to-trash) — all writing clean, Xcode-style pbxproj.
- **Drag & drop** — reorder/reparent references inside the tree (move), or drop files from the Explorer / desktop to add references.
- **Linter + diagnostics** surfaced in the Problems panel, with orange warning tree decorations for files that are referenced by the project but missing on disk.
- **Asset catalogs** — clicking an `.xcassets` reference opens it in the [Asset Catalog Viewer](https://marketplace.visualstudio.com/items?itemName=artemnovichkov.asset-catalog-viewer) extension when installed (silent no-op otherwise); *Open in Asset Catalog Viewer* in the context menu offers to install it. Other folder references (`.bundle`, …) no longer error on click.

## Screenshots

<p align="center">
  <img src="https://raw.githubusercontent.com/phimage/vsxcode/main/media/screenshot-project-navigator.png" alt="Project Navigator screenshot" width="800" />
</p>

Launch the extension (see [Development](#development)) against the bundled `test/fixtures/Sample.xcodeproj` to try it.

## Installation

- From source: see [Building](#building) / [Packaging](#packaging), then install the generated `.vsix` via **Extensions: Install from VSIX…**.

### Recommended companion extensions

- **File icon theme** — install a file-icon theme such as [Material Icon Theme](https://marketplace.visualstudio.com/items?itemName=PKief.material-icon-theme) so the Project Navigator shows recognizable icons per file type (see more [icon themes](https://marketplace.visualstudio.com/search?term=tag%3Aicon-theme&target=VSCode&category=All%20categories&sortBy=Relevance)).
- **Asset catalogs** — install [Asset Catalog Viewer](https://marketplace.visualstudio.com/items?itemName=artemnovichkov.asset-catalog-viewer) to preview and edit `.xcassets` folders; this extension will offer to install it for you the first time you open one (see [Asset catalogs](#features)).

## Usage

1. Open a folder that contains an `.xcodeproj` bundle.
2. Open the **Xcode** view in the activity bar to browse the Project Navigator.
3. Click a file to open it; right-click for **Reveal in File Explorer**.
4. Open `project.pbxproj` for highlighting and an outline; issues appear in the **Problems** panel.

## Supported project types

- `project.pbxproj` (Xcode project files), including Xcode 16 `PBXFileSystemSynchronizedRootGroup` folders.
- `.xcworkspace` bundles (`contents.xcworkspacedata`): round-trip parse/serialize in Xcode's XML formatting, tree browsing with nested projects, inspector editing of names and locations (`group:`, `container:`, `absolute:`…), add/remove references and groups. The implicit `project.xcworkspace` inside every `.xcodeproj` is ignored.

## Commands

| Command | Description |
| --- | --- |
| `PBX: Refresh` | Re-scan the workspace, re-parse and re-lint. |
| `PBX: Validate Project` | Run the linter and report a summary. |
| `PBX: Open` | Open the selected file reference (asset catalogs open in the viewer extension). |
| `PBX: Open in Asset Catalog Viewer` | Open an `.xcassets` folder in the Asset Catalog Viewer extension (offers install if missing). |
| `PBX: Reveal in File Explorer` | Reveal the file/group on disk (OS Finder/File Explorer). |
| `PBX: Reveal in Explorer View` | Reveal the file/group in VS Code's built-in Explorer view. |
| `PBX: Open project.pbxproj` | Open the raw project file. |
| `PBX: New Group` | Create a virtual group under the selection. |
| `PBX: New File…` | Create a file on disk and reference it (with target membership). |
| `PBX: Add Files…` | Add existing file(s)/folder(s) as references. |
| `PBX: Rename…` | Rename a group or file (renames on disk too). |
| `PBX: Remove from Project…` | Remove a reference, optionally moving the file to Trash. |
| `PBX: Open contents.xcworkspacedata` | Open the raw workspace file. |
| `PBX: Open .xcscheme` | Open a shared scheme's XML file. |
| `PBX: Add Files to Workspace…` | Add file/folder/project references to a workspace or workspace group. |
| `PBX: Remove from Workspace…` | Remove a project, file reference or group from the workspace (files on disk untouched). |

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
