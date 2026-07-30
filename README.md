# Pasteboard

Lightweight persistent notes for VS Code — triggered from the **Status Bar**, optimized for typing-first note-taking with autosave.

- **Publisher:** kelvinelove
- **Extension id:** `kelvinelove.pasteboard`
- **Author:** kelvinelove

## Features

- **Status Bar trigger** — `$(clipboard) Pasteboard` on the right side of the Status Bar toggles the sidebar.
- **Typing-first layout** — editor on top; search and saved items at the bottom.
- **Autosave** — enabled by default; saves after idle delay, on explicit Save, and when the view hides/closes.
- **GLOBAL + workspace tabs** — global notes and per-folder workspace notes.
- **Hover delete** — each saved item shows a `✕` on hover (keyboard: focus row + Delete/Backspace).
- **Editor border** — theme-aware border around the typing area (configurable).
- **Synced views** — sidebar WebviewView and optional WebviewPanel stay in sync.

## Quick start (development)

```bash
npm install
npm run compile
```

Press **F5** to launch the Extension Development Host. Click **$(clipboard) Pasteboard** in the Status Bar (bottom-right).

## Opening Pasteboard

### Status Bar (primary)

Click **`Pasteboard`** on the right side of the Status Bar (`$(clipboard) Pasteboard`).

Keyboard: **`Ctrl+Alt+P`** / **`Cmd+Alt+P`** toggles the sidebar.

### Right-side sidebar

VS Code does not allow extensions to force a view into the Secondary Side Bar programmatically. To dock Pasteboard on the **right**:

1. Open Pasteboard from the Status Bar (or Activity Bar icon).
2. **Drag** the Pasteboard view tab to the **Secondary Side Bar** (right side of the window).
3. VS Code remembers the placement.

### Fallback: beside editor

Set `"pasteboard.sidebarMode": "beside"` in settings. The Status Bar toggle then opens a **WebviewPanel** beside the active editor instead of the sidebar view.

You can also use the **⬒** icon in the Pasteboard toolbar to open/close the panel view while keeping the sidebar open — both stay synced.

## Usage

1. Click the Status Bar item to open Pasteboard.
2. Type in the editor (top). Title is optional; content autosaves after idle.
3. Switch **GLOBAL** / workspace tabs in the header.
4. Search and pick saved items in the **bottom** panel.
5. Toolbar icons: **autosave toggle**, **new**, **pin**, **save**, **panel toggle**.
6. Hover a saved item and click **✕** to delete (confirmation respects `pasteboard.confirmDelete`).

## Commands

| Command | Id |
|---|---|
| Pasteboard: Toggle Pasteboard Sidebar | `pasteboard.toggle-sidebar` |
| Pasteboard: Open Pasteboard | `pasteboard.open` |
| Pasteboard: Toggle Panel View | `pasteboard.toggle-panel-position` |
| Pasteboard: New Item | `pasteboard.new-item` |
| Pasteboard: Save Item | `pasteboard.save-item` |
| Pasteboard: Delete Item | `pasteboard.delete-item` |
| Pasteboard: Open Global Tab | `pasteboard.open-global` |

## Keybindings (included in `package.json`)

| Key | Command |
|---|---|
| `Ctrl+Alt+P` / `Cmd+Alt+P` | Toggle Pasteboard sidebar |
| `Ctrl+Alt+N` / `Cmd+Alt+N` | New item (when Pasteboard focused) |
| `Ctrl+Alt+S` / `Cmd+Alt+S` | Save item (when Pasteboard focused) |

## Settings

| Setting | Default | Description |
|---|---|---|
| `pasteboard.autosave` | `true` | Autosave after idle typing |
| `pasteboard.autosaveDelay` | `1000` | Idle delay (ms) before autosave |
| `pasteboard.confirmDelete` | `true` | Confirm before deleting items |
| `pasteboard.maxItems` | `200` | Max items per tab; unpinned pruned oldest-first |
| `pasteboard.editorBorder` | `"1px"` | Editor border width; `false` to disable |
| `pasteboard.sidebarMode` | `"view"` | `"view"` (sidebar) or `"beside"` (panel fallback) |
| `pasteboard.openPanelOnStartup` | `false` | Open panel view on startup |

Example `settings.json`:

```json
{
  "pasteboard.autosave": true,
  "pasteboard.autosaveDelay": 1000,
  "pasteboard.confirmDelete": true,
  "pasteboard.maxItems": 200,
  "pasteboard.editorBorder": "1px",
  "pasteboard.sidebarMode": "view"
}
```

## Data model

Each item: `{ id, title, content, createdAt, updatedAt, pinned }`

**Storage keys**

- Global: `pasteboard.global` in `globalState`
- Workspace: `pasteboard.workspace.<folderUri>` in `workspaceState`

Legacy keys (`workspace-notepad`, `workspace-notepad.notes`) are migrated on activation.

## Build & package

```bash
npm install
npm run compile    # compile TypeScript
npm run watch      # watch mode
npm run package    # build .vsix
```

Debug: open this folder in VS Code → **F5** (uses `.vscode/launch.json`).

## Project layout

```
src/
  extension.ts           # Status Bar, commands, activation
  pasteboardProvider.ts  # WebviewView + WebviewPanel sync
  storage.ts             # Persistence and pruning
  types.ts               # Message contracts
  webview.ts             # Webview UI client
assets/webview.css       # Typing-first layout styles
```

## Security

- CSP with script nonce; scripts loaded via `webview.asWebviewUri`.
- All persistence goes through extension-host message handlers.
- No telemetry.

## License

MIT
