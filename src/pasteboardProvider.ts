import * as vscode from 'vscode';
import { createItem, PasteboardStorage } from './storage';
import { PasteboardPanel } from './pasteboardPanel';
import {
	HostToWebviewMessage,
	PasteboardItem,
	PasteboardUiSettings,
	TabScope,
	WebviewToHostMessage,
	WorkspaceTabInfo
} from './types';

const PANEL_VIEW_TYPE = 'pasteboard.panel';
const VIEW_CONTAINER_ID = 'pasteboard-container';
/** How long an "Undo" toast stays valid after a delete, in milliseconds. */
const UNDO_WINDOW_MS = 6000;

type Placement = 'sidebar-right' | 'sidebar-left' | 'panel-beside';

interface DraftState {
	title: string;
	content: string;
}

interface UiState {
	activeTab: TabScope;
	selectedItemId: string | null;
	drafts: Map<TabScope, DraftState>;
}

interface WebviewUiState {
	activeTab: TabScope;
	selectedItemId: string | null;
	drafts: Map<TabScope, DraftState>;
	dirty: boolean;
	baseline?: Pick<PasteboardItem, 'title' | 'content' | 'updatedAt'>;
}

/**
 * Shared webview controller for the sidebar WebviewView and optional WebviewPanel.
 * Keeps persisted item lists and settings synchronized while isolating each surface's
 * current scope, selection, and draft.
 */
export class PasteboardProvider implements vscode.WebviewViewProvider {
	private view?: vscode.WebviewView;
	private panel?: PasteboardPanel;
	private readonly webviews = new Set<vscode.Webview>();
	private readonly webviewStates = new Map<vscode.Webview, WebviewUiState>();
	private focusedWebview?: vscode.Webview;
	/** Reentrancy guard for toggleSidebar() — see the comment at its call site. */
	private isTogglingSidebar = false;
	/** The most recently deleted item, kept around briefly so "Undo" can restore it. */
	private lastDeleted?: { tabId: TabScope; item: PasteboardItem };
	private undoTimer?: ReturnType<typeof setTimeout>;

	private readonly _onDidChangeOpenState = new vscode.EventEmitter<boolean>();
	/** Fires whenever the sidebar view or Beside panel's visible/open state changes, for the Status Bar highlight. */
	readonly onDidChangeOpenState = this._onDidChangeOpenState.event;

	private readonly uiState: UiState = {
		activeTab: 'global',
		selectedItemId: null,
		drafts: new Map()
	};

	constructor(
		private readonly ctx: vscode.ExtensionContext,
		private readonly storage: PasteboardStorage
	) {}

	// ── WebviewViewProvider ──────────────────────────────────────────────

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		this.attachWebview(webviewView.webview, webviewView.webview.options);

		// The sidebar can become visible via the Activity Bar, the Command Palette, or a
		// drag — none of which go through toggleSidebar()/openPrimaryView(). Enforce
		// "never show the sidebar and the Beside panel at once" here too, not just in our
		// own command handlers, otherwise the panel + sidebar can end up open together.
		if (this.panel) {
			this.closePanel();
		}

		webviewView.onDidChangeVisibility(() => {
			if (!webviewView.visible) {
				const state = this.webviewStates.get(webviewView.webview);
				if (state) {
					void this.flushWebviewDraft(state);
				}
				this.notifyOpenStateChange();
				return;
			}
			if (this.panel) {
				this.closePanel();
			}
			this.notifyOpenStateChange();
		});

		webviewView.onDidDispose(() => {
			const state = this.webviewStates.get(webviewView.webview);
			if (state) {
				void this.flushWebviewDraft(state);
			}
			this.detachWebview(webviewView.webview);
			if (this.view === webviewView) {
				this.view = undefined;
			}
			this.notifyOpenStateChange();
		});

		// VS Code has no memory of a good width for a view container it's never shown
		// before, so the first-ever reveal (including after "Move View > Right" into the
		// Secondary Side Bar) can default to a ~50/50 split. Nudge it toward
		// pasteboard.preferredWidthPercent exactly once, ever — after that VS Code
		// remembers whatever width the sidebar settles at (ours or the user's own
		// resize), so this must never re-run and fight a deliberate manual resize.
		void this.applyCompactSidebarWidthOnce();
		this.notifyOpenStateChange();
	}

	isViewVisible(): boolean {
		return this.view?.visible ?? false;
	}

	/** Whether either surface (sidebar view or Beside panel) is currently visible — drives the Status Bar highlight. */
	isOpen(): boolean {
		return (this.view?.visible ?? false) || (this.panel?.visible ?? false);
	}

	private notifyOpenStateChange(): void {
		this._onDidChangeOpenState.fire(this.isOpen());
	}

	private async applyCompactSidebarWidthOnce(): Promise<void> {
		const alreadySized = this.ctx.globalState.get<boolean>('pasteboard.sidebarWidthInitialized', false);
		if (alreadySized) {
			return;
		}
		await this.ctx.globalState.update('pasteboard.sidebarWidthInitialized', true);

		const preferredWidthPercent = vscode.workspace
			.getConfiguration('pasteboard')
			.get<number>('preferredWidthPercent', 28);
		const steps = Math.max(1, Math.min(6, Math.round((100 - preferredWidthPercent) / 10)));
		for (let i = 0; i < steps; i += 1) {
			await new Promise(resolve => setTimeout(resolve, 60));
			await vscode.commands.executeCommand('workbench.action.decreaseViewSize');
		}
	}

	// ── Toggle logic: sidebar view or compact panel fallback ─────────────

	async toggleSidebar(): Promise<void> {
		// This is the one genuinely async path in this class (openPrimaryView awaits a
		// reveal command below). Guard it so two rapid Status Bar clicks can't both pass
		// the visibility check before the first reveal resolves. openPanel()/closePanel()/
		// togglePanelPosition() are synchronous and run to completion atomically, so they
		// don't need — and must not get — the same guard: toggleSidebar() calls them
		// internally, and re-checking a shared flag inside them would make those nested
		// calls silently no-op.
		if (this.isTogglingSidebar) {
			return;
		}
		this.isTogglingSidebar = true;
		try {
			const mode = vscode.workspace
				.getConfiguration('pasteboard')
				.get<'view' | 'beside'>('sidebarMode', 'view');

			if (mode === 'beside') {
				this.togglePanelPosition();
				return;
			}

			if (this.view?.visible || this.panel?.visible) {
				this.closeAll();
				return;
			}

			await this.openPrimaryView();
		} finally {
			this.isTogglingSidebar = false;
		}
	}

	async openPrimaryView(): Promise<void> {
		const desiredPlacement = this.getStoredPlacement();
		if (desiredPlacement === 'panel-beside') {
			this.openPanel();
			return;
		}

		// Never reveal the sidebar while a Beside panel is still open — e.g. after the
		// user picks "Right sidebar" from Set Default Placement without having closed an
		// already-open panel first.
		if (this.panel) {
			this.closePanel();
		}

		if (this.view?.visible) {
			return;
		}

		await vscode.commands.executeCommand(`workbench.view.extension.${VIEW_CONTAINER_ID}`);
		await this.updatePlacement('sidebar-right');
	}

	// ── WebviewPanel (toolbar / compact fallback) ────────────────────────

	openPanel(): void {
		if (this.panel) {
			this.panel.reveal();
			void this.updatePlacement('panel-beside');
			this.notifyOpenStateChange();
			return;
		}

		// No longer force-closing the sidebar here before opening the panel — that used
		// workbench.action.closeSidebar, which collapses the whole Primary Side Bar and
		// forces an editor/terminal reflow as an unrequested side effect of opening the
		// panel. The sidebar and the Beside panel can now both be visible at once; that's
		// minor redundancy (the same notes shown twice), not corruption — the actual bug
		// that guard was defending against (duplicate message-listener registration
		// causing the panel to close-then-reopen itself) is fixed at the source in
		// pasteboardPanel.ts.

		let panelInstance!: PasteboardPanel;
		panelInstance = new PasteboardPanel(this.ctx, {
			viewType: PANEL_VIEW_TYPE,
			title: 'Pasteboard',
			onDidDispose: () => {
				const state = this.webviewStates.get(panelInstance.webview);
				if (state) {
					void this.flushWebviewDraft(state);
				}
				this.detachWebview(panelInstance.webview);
				if (this.panel === panelInstance) {
					this.panel = undefined;
				}
				this.notifyOpenStateChange();
			},
			onDidChangeViewState: () => this.notifyOpenStateChange(),
			extensionUri: this.ctx.extensionUri
		});
		this.panel = panelInstance;

		// Single place that sets html and wires the message listener — see the comment
		// in pasteboardPanel.ts for why this must not also happen inside PasteboardPanel.
		this.attachWebview(this.panel.webview, this.panel.webview.options);
		void this.updatePlacement('panel-beside');
		this.notifyOpenStateChange();
	}

	closePanel(): void {
		this.panel?.dispose();
		this.panel = undefined;
		this.notifyOpenStateChange();
	}

	isPanelOpen(): boolean {
		return this.panel !== undefined;
	}

	private closeAll(): void {
		if (this.panel) {
			this.panel.dispose();
			this.panel = undefined;
		}
		if (this.view?.visible) {
			// Deliberately NOT calling workbench.action.closeSidebar here: it collapses
			// the entire Primary Side Bar (Explorer/Search/whatever else is showing too,
			// not just Pasteboard's own view), and doing so always makes VS Code reflow
			// the editor and panel/terminal into the freed space — a much bigger, more
			// disruptive effect than toggling a small Status Bar icon should cause. There
			// is no VS Code API to hide a single view container without that reflow, so
			// we no longer force it; just hand focus back to the editor instead. Use the
			// Activity Bar icon or Ctrl/Cmd+B to actually collapse the Side Bar.
			void vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
		}
		// Do NOT null this.view here: VS Code only calls resolveWebviewView() once per
		// session and keeps reusing the same WebviewView instance across visibility
		// toggles, so this.view stays valid (just hidden) — nulling it here would
		// permanently desync our bookkeeping from reality after the first close.
		this.notifyOpenStateChange();
	}

	// ── Commands ─────────────────────────────────────────────────────────

	async focusSidebarView(): Promise<void> {
		await vscode.commands.executeCommand(`workbench.view.extension.${VIEW_CONTAINER_ID}`);
	}

	togglePanelPosition(): void {
		if (this.panel) {
			this.closePanel();
		} else {
			this.openPanel();
		}
	}

	switchToGlobalTab(): void {
		this.uiState.activeTab = 'global';
		this.uiState.selectedItemId = null;
		for (const state of this.webviewStates.values()) {
			state.activeTab = 'global';
			state.selectedItemId = null;
			state.drafts.set('global', { title: '', content: '' });
			state.baseline = undefined;
			state.dirty = false;
		}
		this.broadcastState();
	}

	async newItem(): Promise<void> {
		this.uiState.selectedItemId = null;
		this.setDraft(this.uiState.activeTab, { title: '', content: '' });
		this.broadcastState();
		this.postCommandToWebviews('new');
	}

	async saveItem(): Promise<void> {
		const focusedState = this.focusedWebview ? this.webviewStates.get(this.focusedWebview) : undefined;
		if (focusedState) {
			await this.flushWebviewDraft(focusedState);
			return;
		}
		const draft = this.getDraft(this.uiState.activeTab);
		await this.persistDraft(this.uiState.activeTab, this.uiState.selectedItemId, draft.title, draft.content);
	}

	async deleteItem(): Promise<void> {
		if (!this.uiState.selectedItemId) {
			void vscode.window.showWarningMessage('Pasteboard: No item selected.');
			return;
		}
		await this.persistDelete(this.uiState.activeTab, this.uiState.selectedItemId);
	}

	/** Captures the active editor's selection as a new item, titled with its file:line, without disrupting editor focus. */
	async captureSelection(): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor || editor.selection.isEmpty) {
			void vscode.window.showWarningMessage('Pasteboard: Select some text first.');
			return;
		}

		const content = editor.document.getText(editor.selection);
		const tabId = this.scopeForDocument(editor.document);
		const relativePath = vscode.workspace.asRelativePath(editor.document.uri, false);
		const startLine = editor.selection.start.line + 1;
		const endLine = editor.selection.end.line + 1;
		const title = startLine === endLine ? `${relativePath}:${startLine}` : `${relativePath}:${startLine}-${endLine}`;

		await this.persistCreate(tabId, title, content);

		const choice = await vscode.window.showInformationMessage(`Pasteboard: Added "${title}"`, 'Show');
		if (choice === 'Show') {
			await this.openPrimaryView();
		}
	}

	/** Populates a fresh draft from the clipboard so the user can review/edit before it's saved. */
	async newItemFromClipboard(): Promise<void> {
		const text = await vscode.env.clipboard.readText();
		if (!text.trim()) {
			void vscode.window.showWarningMessage('Pasteboard: Clipboard is empty.');
			return;
		}
		this.uiState.selectedItemId = null;
		this.setDraft(this.uiState.activeTab, { title: '', content: text });
		this.broadcastState();
		this.postCommandToWebviews('focusEditor');
	}

	/** Quick Pick across every tab (including GLOBAL) — scales better than the sidebar list once there are many items. */
	async quickOpenItem(): Promise<void> {
		interface ItemQuickPickItem extends vscode.QuickPickItem {
			tabId: TabScope;
			itemId: string;
		}

		const entries: ItemQuickPickItem[] = [];
		for (const tab of this.storage.getWorkspaceTabs()) {
			for (const item of this.storage.getItems(tab.id)) {
				entries.push({
					label: `${item.pinned ? '$(pin) ' : ''}${item.title || 'Untitled'}`,
					description: tab.label,
					detail: item.content.replace(/\s+/g, ' ').slice(0, 120),
					tabId: tab.id,
					itemId: item.id
				});
			}
		}

		if (entries.length === 0) {
			void vscode.window.showInformationMessage('Pasteboard: No saved items yet.');
			return;
		}

		const picked = await vscode.window.showQuickPick(entries, {
			placeHolder: 'Search all Pasteboard items…',
			matchOnDescription: true,
			matchOnDetail: true
		});
		if (!picked) {
			return;
		}

		await this.openPrimaryView();
		await this.selectItem(picked.tabId, picked.itemId);
	}

	/** Dumps every item in the currently active tab into a throwaway Markdown document the user can Save As wherever they like. */
	async exportActiveTabToMarkdown(): Promise<void> {
		const tabId = this.uiState.activeTab;
		const items = this.storage.getItems(tabId);
		if (items.length === 0) {
			void vscode.window.showInformationMessage('Pasteboard: Nothing to export in this tab.');
			return;
		}

		const label = this.storage.getWorkspaceTabs().find(t => t.id === tabId)?.label ?? String(tabId);
		const sorted = [...items].sort((a, b) => b.updatedAt - a.updatedAt);
		const sections = sorted.map(item => {
			const heading = `## ${item.pinned ? '📌 ' : ''}${item.title || 'Untitled'}`;
			const meta = `_Updated ${new Date(item.updatedAt).toLocaleString()}_`;
			return `${heading}\n\n${meta}\n\n${item.content}\n`;
		});
		const markdown = `# Pasteboard — ${label}\n\n${sections.join('\n---\n\n')}`;

		const doc = await vscode.workspace.openTextDocument({ content: markdown, language: 'markdown' });
		await vscode.window.showTextDocument(doc, { preview: false });
	}

	/** Maps a document to the same TabScope id getWorkspaceTabs() would assign its containing folder. */
	private scopeForDocument(document: vscode.TextDocument): TabScope {
		const folder = vscode.workspace.getWorkspaceFolder(document.uri);
		if (folder) {
			return folder.uri.toString();
		}
		return (vscode.workspace.workspaceFolders?.length ?? 0) > 0 ? 'global' : 'local';
	}

	/** Persist the current draft when the view hides or closes. */
	async flushDraft(): Promise<void> {
		const autosave = vscode.workspace.getConfiguration('pasteboard').get<boolean>('autosave', true);
		if (!autosave) {
			return;
		}
		const draft = this.getDraft(this.uiState.activeTab);
		await this.persistDraft(
			this.uiState.activeTab,
			this.uiState.selectedItemId,
			draft.title,
			draft.content,
			true
		);
	}

	refreshTabs(): void {
		const tabs = this.storage.getWorkspaceTabs();
		if (!tabs.some(t => t.id === this.uiState.activeTab)) {
			this.uiState.activeTab = 'global';
			this.uiState.selectedItemId = null;
		}
		if (this.webviews.size > 0) {
			this.sendInit();
		}
	}

	broadcastSettings(): void {
		const message: HostToWebviewMessage = {
			type: 'settingsUpdate',
			settings: this.getUiSettings()
		};
		this.postToAll(message);
	}

	// ── Webview wiring ───────────────────────────────────────────────────

	private attachWebview(webview: vscode.Webview, existingOptions: vscode.WebviewOptions): void {
		webview.options = {
			...existingOptions,
			enableScripts: true,
			localResourceRoots: [
				vscode.Uri.joinPath(this.ctx.extensionUri, 'assets'),
				vscode.Uri.joinPath(this.ctx.extensionUri, 'out')
			]
		};

		webview.html = this.buildHtml(webview);
		this.webviews.add(webview);
		this.webviewStates.set(webview, {
			activeTab: this.uiState.activeTab,
			selectedItemId: this.uiState.selectedItemId,
			drafts: new Map(this.uiState.drafts),
			dirty: false
		});

		webview.onDidReceiveMessage((msg: WebviewToHostMessage) => {
			void this.handleMessage(webview, msg);
		});
	}

	private detachWebview(webview: vscode.Webview): void {
		this.webviews.delete(webview);
		this.webviewStates.delete(webview);
	}

	private buildHtml(webview: vscode.Webview): string {
		const styleUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.ctx.extensionUri, 'assets', 'webview.css')
		);
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.ctx.extensionUri, 'out', 'webview.js')
		);
		const nonce = getNonce();

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<link rel="stylesheet" href="${styleUri}" />
	<title>Pasteboard</title>
</head>
<body>
	<header class="header">
		<div id="tabs" class="tabs" role="tablist" aria-label="Pasteboard scopes"></div>
		<nav class="icon-toolbar" aria-label="Pasteboard actions">
			<div class="toolbar-group toolbar-primary" role="group" aria-label="Note actions">
				<button id="btn-new" type="button" class="icon-btn icon-btn-primary" tabindex="0" aria-label="New note" data-tooltip="New note">
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
						<path d="M12 5v14M5 12h14" />
					</svg>
				</button>
				<button id="btn-save" type="button" class="icon-btn" tabindex="0" aria-label="Save note" data-tooltip="Save note">
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
						<path d="M5 4h12l3 3v13H4V5a1 1 0 0 1 1-1Z" />
						<path d="M8 4v6h8V4M8 20v-6h8v6" />
					</svg>
				</button>
			</div>
			<span class="toolbar-divider" aria-hidden="true"></span>
			<div class="toolbar-group" role="group" aria-label="Selected note actions">
			<button id="btn-pin" type="button" class="icon-btn" tabindex="0" aria-label="Pin or unpin" aria-pressed="false" data-tooltip="Pin or unpin" disabled>
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<path d="M9 4h6" />
					<path d="M10 4v5l-3.5 3.5V14h11v-1.5L14 9V4M12 14v6" />
				</svg>
			</button>
			<button id="btn-duplicate" type="button" class="icon-btn" tabindex="0" aria-label="Duplicate note" data-tooltip="Duplicate note" disabled>
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<rect x="8" y="8" width="12" height="12" rx="1.5" />
					<path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" />
				</svg>
			</button>
			</div>
			<span class="toolbar-divider" aria-hidden="true"></span>
			<div class="toolbar-group" role="group" aria-label="View and save options">
			<button id="btn-autosave" type="button" class="icon-btn" tabindex="0" aria-label="Toggle autosave" aria-pressed="true" data-tooltip="Toggle autosave">
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<path d="M6.5 18.5h11a4 4 0 0 0 .6-7.95A6.5 6.5 0 0 0 5.7 9.1a4.8 4.8 0 0 0 .8 9.4Z" />
					<path d="m9 13 2 2 4-4" />
				</svg>
			</button>
			<button id="btn-panel" type="button" class="icon-btn" tabindex="0" aria-label="Toggle panel view" data-tooltip="Toggle panel view">
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<rect x="3.5" y="4.5" width="17" height="15" rx="1.5" />
					<path d="M14.5 4.5v15" />
				</svg>
			</button>
			</div>
		</nav>
	</header>

	<main class="editor-section">
		<div id="editor-frame" class="editor-frame">
			<input id="title-input" type="text" placeholder="Title" aria-label="Item title" tabindex="1" />
			<textarea id="content-input" placeholder="Write your note…" aria-label="Item content" tabindex="2"></textarea>
		</div>
		<div id="autosave-indicator" class="autosave-indicator" aria-live="polite"></div>
	</main>

	<footer class="bottom-panel">
		<label class="search-field">
			<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.3"/><path d="m15.5 15.5 4.2 4.2"/></svg>
			<input id="search" type="search" placeholder="Search notes" aria-label="Search notes" tabindex="3" />
		</label>
		<ul id="item-list" class="item-list" role="listbox" aria-label="Saved items"></ul>
		<p id="empty-state" class="empty-state" hidden>No saved items yet. Write above to create your first note.</p>
	</footer>

	<div id="undo-toast" class="undo-toast" role="status" hidden>
		<span id="undo-toast-text"></span>
		<button id="undo-toast-btn" type="button" class="undo-toast-btn">Undo</button>
	</div>

	<script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
	}

	// ── Message handling ─────────────────────────────────────────────────

	private async handleMessage(webview: vscode.Webview, msg: WebviewToHostMessage): Promise<void> {
		const state = this.webviewStates.get(webview);
		if (!state) {
			return;
		}
		try {
			switch (msg.type) {
				case 'ready':
					this.sendInit(webview);
					break;
				case 'switchTab':
					if (!await this.resolvePendingDraft(state)) {
						break;
					}
					state.drafts.set(state.activeTab, { title: '', content: '' });
					state.activeTab = msg.tabId;
					state.selectedItemId = null;
					state.drafts.set(msg.tabId, { title: '', content: '' });
					state.baseline = undefined;
					state.dirty = false;
					this.broadcastState(webview);
					break;
				case 'selectItem':
					await this.selectWebviewItem(webview, state, msg.tabId, msg.itemId);
					break;
				case 'draftChange':
					if (state.selectedItemId !== msg.itemId || state.activeTab !== msg.tabId) {
						state.baseline = msg.itemId
							? this.storage.getItems(msg.tabId).find(item => item.id === msg.itemId)
							: undefined;
					}
					state.activeTab = msg.tabId;
					state.selectedItemId = msg.itemId;
					state.drafts.set(msg.tabId, { title: msg.title, content: msg.content });
					state.dirty = true;
					break;
				case 'createItem':
					await this.persistWebviewDraft(state, msg.tabId, null, msg.title, msg.content);
					if (msg.revision !== undefined) {
						this.postTo(webview, { type: 'autosaveAck', itemId: state.selectedItemId, savedAt: Date.now(), revision: msg.revision });
					}
					break;
				case 'updateItem':
					await this.persistWebviewDraft(state, msg.tabId, msg.item.id, msg.item.title, msg.item.content);
					if (msg.revision !== undefined) {
						this.postTo(webview, { type: 'autosaveAck', itemId: msg.item.id, savedAt: Date.now(), revision: msg.revision });
					}
					break;
				case 'autosave': {
					const saved = await this.persistWebviewDraft(state, msg.tabId, msg.itemId, msg.title, msg.content);
					if (saved) {
						this.postTo(webview, {
							type: 'autosaveAck',
							itemId: msg.itemId,
							savedAt: Date.now(),
							revision: msg.revision
						});
					}
					break;
				}
				case 'deleteItem':
					await this.persistDelete(msg.tabId, msg.itemId);
					break;
				case 'undoDelete':
					await this.undoDelete(msg.tabId, msg.itemId);
					break;
				case 'duplicateItem':
					await this.persistDuplicate(msg.tabId, msg.itemId);
					break;
				case 'togglePin':
					await this.persistTogglePin(msg.tabId, msg.itemId);
					break;
				case 'setAutosave':
					await vscode.workspace
						.getConfiguration('pasteboard')
						.update('autosave', msg.enabled, vscode.ConfigurationTarget.Global);
					this.broadcastSettings();
					break;
				case 'togglePanel':
					this.togglePanelPosition();
					break;
				case 'focus':
					this.focusedWebview = webview;
					await vscode.commands.executeCommand('setContext', 'pasteboardFocused', true);
					break;
				case 'blur':
					if (this.focusedWebview === webview) {
						this.focusedWebview = undefined;
					}
					await vscode.commands.executeCommand('setContext', 'pasteboardFocused', false);
					break;
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.postError(message);
		}
	}

	/** Returns true when a write actually happened, so callers (e.g. autosave ack) can distinguish a real save from a skipped empty draft. */
	private async persistDraft(
		tabId: TabScope,
		itemId: string | null,
		title: string,
		content: string,
		silent = false
	): Promise<boolean> {
		if (!title.trim() && !content.trim()) {
			return false;
		}
		if (itemId) {
			const existing = this.storage.getItems(tabId).find(i => i.id === itemId);
			if (existing) {
				await this.persistUpdate(tabId, { ...existing, title, content }, silent);
				return true;
			}
		}
		await this.persistCreate(tabId, title, content, silent);
		return true;
	}

	private async persistCreate(
		tabId: TabScope,
		title: string,
		content: string,
		_silent = false
	): Promise<void> {
		const item = createItem(title, content);
		const items = [...this.storage.getItems(tabId), item];
		await this.storage.setItems(tabId, items);
		this.uiState.activeTab = tabId;
		this.uiState.selectedItemId = item.id;
		this.setDraft(tabId, { title: item.title, content: item.content });
		this.broadcastState();
	}

	private async persistUpdate(
		tabId: TabScope,
		item: PasteboardItem,
		_silent = false
	): Promise<void> {
		const items = this.storage.getItems(tabId);
		const idx = items.findIndex(i => i.id === item.id);
		if (idx === -1) {
			throw new Error('Item not found');
		}
		const updated: PasteboardItem = {
			...items[idx],
			title: item.title.trim() || 'Untitled',
			content: item.content,
			updatedAt: Date.now()
		};
		items[idx] = updated;
		await this.storage.setItems(tabId, items);
		this.uiState.selectedItemId = updated.id;
		this.setDraft(tabId, { title: updated.title, content: updated.content });
		this.broadcastState();
	}

	/** Shared by the webview's selectItem message and the Quick Open command. */
	private async selectItem(tabId: TabScope, itemId: string | null): Promise<void> {
		await this.flushDraft();
		this.uiState.activeTab = tabId;
		this.uiState.selectedItemId = itemId;
		for (const state of this.webviewStates.values()) {
			state.activeTab = tabId;
			state.selectedItemId = itemId;
		}
		if (itemId) {
			const item = this.storage.getItems(tabId).find(i => i.id === itemId);
			if (item) {
				this.setDraft(tabId, { title: item.title, content: item.content });
				for (const state of this.webviewStates.values()) {
					state.drafts.set(tabId, { title: item.title, content: item.content });
					state.baseline = { title: item.title, content: item.content, updatedAt: item.updatedAt };
					state.dirty = false;
				}
			}
		} else {
			this.setDraft(tabId, { title: '', content: '' });
			for (const state of this.webviewStates.values()) {
				state.drafts.set(tabId, { title: '', content: '' });
				state.baseline = undefined;
				state.dirty = false;
			}
		}
		this.broadcastState();
		this.postCommandToWebviews('focusEditor');
	}

	private async flushWebviewDraft(state: WebviewUiState): Promise<void> {
		const configAutosave = vscode.workspace.getConfiguration('pasteboard').get<boolean>('autosave', true);
		if (!configAutosave) {
			return;
		}
		const draft = state.drafts.get(state.activeTab) ?? { title: '', content: '' };
		const existing = state.selectedItemId
			? this.storage.getItems(state.activeTab).find(item => item.id === state.selectedItemId)
			: undefined;
		if (existing && existing.title === (draft.title.trim() || 'Untitled') && existing.content === draft.content) {
			return;
		}
		await this.persistWebviewDraft(state, state.activeTab, state.selectedItemId, draft.title, draft.content);
	}

	private async resolvePendingDraft(state: WebviewUiState): Promise<boolean> {
		const draft = state.drafts.get(state.activeTab) ?? { title: '', content: '' };
		const existing = state.selectedItemId
			? this.storage.getItems(state.activeTab).find(item => item.id === state.selectedItemId)
			: undefined;
		const dirty = existing
			? existing.title !== (draft.title.trim() || 'Untitled') || existing.content !== draft.content
			: Boolean(draft.title.trim() || draft.content.trim());
		if (!dirty) {
			return true;
		}
		if (vscode.workspace.getConfiguration('pasteboard').get<boolean>('autosave', true)) {
			await this.flushWebviewDraft(state);
			return true;
		}
		const choice = await vscode.window.showWarningMessage(
			'This draft has unsaved changes.',
			{ modal: true },
			'Save', 'Discard'
		);
		if (choice === 'Save') {
			await this.persistWebviewDraft(state, state.activeTab, state.selectedItemId, draft.title, draft.content);
			return true;
		}
		return choice === 'Discard';
	}

	private async persistWebviewDraft(state: WebviewUiState, tabId: TabScope, itemId: string | null, title: string, content: string): Promise<boolean> {
		if (!title.trim() && !content.trim()) {
			return false;
		}
		const items = this.storage.getItems(tabId);
		const existing = itemId ? items.find(item => item.id === itemId) : undefined;
		if (existing) {
			if (state.dirty && state.baseline && (state.baseline.updatedAt !== existing.updatedAt || state.baseline.title !== existing.title || state.baseline.content !== existing.content)) {
				throw new Error('This note changed in another Pasteboard view. Copy your draft, reload the note, then apply your changes.');
			}
			const index = items.findIndex(item => item.id === existing.id);
			items[index] = { ...existing, title: title.trim() || 'Untitled', content, updatedAt: Date.now() };
			await this.storage.setItems(tabId, items);
			state.selectedItemId = existing.id;
			state.drafts.set(tabId, { title: items[index].title, content });
			state.baseline = { title: items[index].title, content, updatedAt: items[index].updatedAt };
		} else {
			const item = createItem(title, content);
			await this.storage.setItems(tabId, [...items, item]);
			state.selectedItemId = item.id;
			state.drafts.set(tabId, { title: item.title, content });
			state.baseline = { title: item.title, content, updatedAt: item.updatedAt };
		}
		state.dirty = false;
		for (const peer of this.webviewStates.values()) {
			if (peer !== state && peer.activeTab === tabId && peer.selectedItemId === state.selectedItemId && !peer.dirty) {
				peer.drafts.set(tabId, { title: state.drafts.get(tabId)?.title ?? '', content: state.drafts.get(tabId)?.content ?? '' });
				peer.baseline = state.baseline;
			}
		}
		this.broadcastState();
		return true;
	}

	private async selectWebviewItem(webview: vscode.Webview, state: WebviewUiState, tabId: TabScope, itemId: string | null): Promise<void> {
		if (!await this.resolvePendingDraft(state)) {
			return;
		}
		if (state.activeTab !== tabId) {
			state.drafts.set(state.activeTab, { title: '', content: '' });
		}
		state.activeTab = tabId;
		state.selectedItemId = itemId;
		const item = itemId ? this.storage.getItems(tabId).find(candidate => candidate.id === itemId) : undefined;
		state.drafts.set(tabId, item ? { title: item.title, content: item.content } : { title: '', content: '' });
		state.baseline = item ? { title: item.title, content: item.content, updatedAt: item.updatedAt } : undefined;
		state.dirty = false;
		this.broadcastState(webview);
	}

	private async persistDelete(tabId: TabScope, itemId: string): Promise<void> {
		const confirmDelete = vscode.workspace
			.getConfiguration('pasteboard')
			.get<boolean>('confirmDelete', true);

		const item = this.storage.getItems(tabId).find(i => i.id === itemId);
		if (confirmDelete) {
			const answer = await vscode.window.showWarningMessage(
				`Delete "${item?.title ?? 'this item'}" from Pasteboard?`,
				{ modal: true },
				'Delete'
			);
			if (answer !== 'Delete') {
				return;
			}
		}
		if (!item) {
			return;
		}

		const items = this.storage.getItems(tabId).filter(i => i.id !== itemId);
		await this.storage.setItems(tabId, items);

		if (this.uiState.selectedItemId === itemId) {
			this.uiState.selectedItemId = null;
			this.setDraft(tabId, { title: '', content: '' });
		}
		this.broadcastState();
		this.offerUndo(tabId, item);
	}

	/** Offers a timed "Undo" for the just-deleted item: a toast in any open webview, or a native prompt if none is open. */
	private offerUndo(tabId: TabScope, item: PasteboardItem): void {
		if (this.undoTimer) {
			clearTimeout(this.undoTimer);
		}
		this.lastDeleted = { tabId, item };
		this.undoTimer = setTimeout(() => {
			this.lastDeleted = undefined;
		}, UNDO_WINDOW_MS);

		if (this.webviews.size > 0) {
			this.postToAll({ type: 'itemDeleted', tabId, item });
			return;
		}
		void vscode.window.showInformationMessage(`Pasteboard: Deleted "${item.title}"`, 'Undo').then(choice => {
			if (choice === 'Undo') {
				void this.undoDelete(tabId, item.id);
			}
		});
	}

	private async undoDelete(tabId: TabScope, itemId: string): Promise<void> {
		if (!this.lastDeleted || this.lastDeleted.tabId !== tabId || this.lastDeleted.item.id !== itemId) {
			return; // the undo window expired, or this doesn't match the last delete
		}
		if (this.undoTimer) {
			clearTimeout(this.undoTimer);
		}
		const restored = this.lastDeleted.item;
		this.lastDeleted = undefined;

		const items = [...this.storage.getItems(tabId), restored];
		await this.storage.setItems(tabId, items);
		this.uiState.activeTab = tabId;
		this.uiState.selectedItemId = restored.id;
		this.setDraft(tabId, { title: restored.title, content: restored.content });
		this.broadcastState();
	}

	private async persistDuplicate(tabId: TabScope, itemId: string): Promise<void> {
		const existing = this.storage.getItems(tabId).find(i => i.id === itemId);
		if (!existing) {
			return;
		}
		// Duplicates start unpinned even if the original was pinned, so copies don't
		// silently double up pinned clutter at the top of the list.
		await this.persistCreate(tabId, `${existing.title} (copy)`, existing.content);
	}

	private async persistTogglePin(tabId: TabScope, itemId: string): Promise<void> {
		const items = this.storage.getItems(tabId);
		const idx = items.findIndex(i => i.id === itemId);
		if (idx === -1) {
			return;
		}
		items[idx] = { ...items[idx], pinned: !items[idx].pinned, updatedAt: Date.now() };
		await this.storage.setItems(tabId, items);
		this.broadcastState();
	}

	private async updatePlacement(placement: Placement): Promise<void> {
		await this.ctx.globalState.update('pasteboard.lastPlacement', placement);
	}

	private getStoredPlacement(): Placement {
		const stored = this.ctx.globalState.get<Placement>('pasteboard.lastPlacement');
		return stored ?? 'sidebar-right';
	}

	// ── State sync ───────────────────────────────────────────────────────

	private getDraft(tabId: TabScope): DraftState {
		return this.uiState.drafts.get(tabId) ?? { title: '', content: '' };
	}

	private setDraft(tabId: TabScope, draft: DraftState): void {
		this.uiState.drafts.set(tabId, draft);
	}

	private getUiSettings(): PasteboardUiSettings {
		const config = vscode.workspace.getConfiguration('pasteboard');
		return {
			confirmDelete: config.get<boolean>('confirmDelete', true),
			autosave: config.get<boolean>('autosave', true),
			// Clamp so a user-set extreme (e.g. 0ms or 10min) can't flood the host or feel broken.
			autosaveDelay: Math.min(10000, Math.max(250, config.get<number>('autosaveDelay', 1000))),
			editorBorder: config.get<string | boolean>('editorBorder', '1px')
		};
	}

	/** getWorkspaceTabs() enriched with each tab's live item count, for the tab pill badges. */
	private getTabsWithCounts(): WorkspaceTabInfo[] {
		return this.storage.getWorkspaceTabs().map(tab => ({
			...tab,
			count: this.storage.getItems(tab.id).length
		}));
	}

	private sendInit(target?: vscode.Webview): void {
		const tabs = this.getTabsWithCounts();
		const destinations = target ? [target] : [...this.webviews];
		for (const webview of destinations) {
			const state = this.webviewStates.get(webview);
			if (!state) {
				continue;
			}
			if (state.activeTab !== 'global' && !tabs.some(t => t.id === state.activeTab)) {
				state.activeTab = tabs[0]?.id ?? 'global';
			}
			const message: HostToWebviewMessage = {
				type: 'init', tabs, activeTab: state.activeTab,
				items: this.storage.getItems(state.activeTab), selectedItemId: state.selectedItemId,
				draft: state.drafts.get(state.activeTab) ?? { title: '', content: '' }, settings: this.getUiSettings()
			};
			this.postSafely(webview, message);
		}
	}

	private broadcastState(target?: vscode.Webview): void {
		const tabs = this.getTabsWithCounts();
		for (const webview of target ? [target] : [...this.webviews]) {
			const state = this.webviewStates.get(webview);
			if (!state) {
				continue;
			}
			const message: HostToWebviewMessage = {
				type: 'stateUpdate', tabs, activeTab: state.activeTab,
				items: this.storage.getItems(state.activeTab), selectedItemId: state.selectedItemId,
				draft: state.drafts.get(state.activeTab) ?? { title: '', content: '' }
			};
			this.postSafely(webview, message);
		}
	}

	private postCommandToWebviews(
		command: 'new' | 'save' | 'delete' | 'openGlobal' | 'focusEditor'
	): void {
		this.postToAll({ type: 'command', command });
	}

	private postError(message: string): void {
		this.postToAll({ type: 'error', message });
		void vscode.window.showErrorMessage(`Pasteboard: ${message}`);
	}

	private postToAll(message: HostToWebviewMessage): void {
		for (const webview of this.webviews) {
			this.postSafely(webview, message);
		}
	}

	private postTo(webview: vscode.Webview, message: HostToWebviewMessage): void {
		this.postSafely(webview, message);
	}

	private postSafely(webview: vscode.Webview, message: HostToWebviewMessage): void {
		try {
			void webview.postMessage(message).then(sent => {
				if (!sent) {
					this.detachWebview(webview);
				}
			}, () => this.detachWebview(webview));
		} catch {
			// A panel may be disposed between a lifecycle event and this post. Remove it
			// from fan-out immediately so later updates never target the dead webview.
			this.detachWebview(webview);
		}
	}
}

function getNonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let text = '';
	for (let i = 0; i < 32; i++) {
		text += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return text;
}

export { PANEL_VIEW_TYPE, VIEW_CONTAINER_ID };
