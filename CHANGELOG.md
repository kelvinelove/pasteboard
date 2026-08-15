# Change Log

## 0.5.0

Initial public release.

- Compact, typing-first note editor in a sidebar WebviewView (or an optional Beside panel), with GLOBAL and per-workspace tabs.
- Icon-only `$(clipboard)` Status Bar toggle on the right.
- Autosave with a configurable, clamped (250–10000ms) idle delay; flushes on hide/close/blur, and confirms with the host once a save actually persists.
- Modern stroke-based SVG toolbar: autosave on/off, new, pin/unpin, duplicate, save, and panel toggle — all theme-aware (light/dark/high-contrast) and keyboard-accessible.
- Custom hover/focus tooltips on every icon, tab, and list control (native `title` tooltips don't reliably render inside VS Code webviews).
- Quick capture: "Add Selection to Pasteboard" from the editor context menu (`Ctrl/Cmd+Alt+Shift+P`), "New Item from Clipboard", and a cross-tab Quick Open (`Ctrl/Cmd+Alt+O`).
- Deletion safety net: a few-seconds "Undo" toast after every delete, plus a notification whenever `pasteboard.maxItems` pruning actually removes something.
- "Export Current Tab to Markdown" for a quick, non-cloud manual export.
- Item counts on each tab pill.
- Optional `pasteboard.storageMode: "file"` — persists per-workspace items to `.vscode/pasteboard.json` for cross-IDE/cross-window sharing, with live file-watching. GLOBAL always stays in `globalState`.
- Placement (sidebar-right/left, or Beside panel) is remembered across sessions; the sidebar's first-ever width is nudged toward `pasteboard.preferredWidthPercent` so it doesn't default to a 50/50 split.
- Legacy `workspace-notepad` data is migrated automatically on activation.
