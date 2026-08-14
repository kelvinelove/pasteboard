import * as vscode from 'vscode';
import { createItem, PasteboardStorage } from './storage';
import { PasteboardPanel } from './pasteboardPanel';
import {
	HostToWebviewMessage,
	PasteboardItem,
	PasteboardUiSettings,
	TabScope,
	WebviewToHostMessage
} from './types';

const PANEL_VIEW_TYPE = 'pasteboard.panel';
const VIEW_CONTAINER_ID = 'pasteboard-container';

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

/**
 * Shared webview controller for the sidebar WebviewView and optional WebviewPanel.
 * Keeps item lists, drafts, and settings synchronized across all open webviews.
 */
export class PasteboardProvider implements vscode.WebviewViewProvider {
	private view?: vscode.WebviewView;
	private panel?: PasteboardPanel;
	private readonly webviews = new Set<vscode.Webview>();

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

		webviewView.onDidChangeVisibility(() => {
			if (!webviewView.visible) {
				void this.flushDraft();
			}
		});

		webviewView.onDidDispose(() => {
			void this.flushDraft();
			this.detachWebview(webviewView.webview);
			this.view = undefined;
		});
	}

	isViewVisible(): boolean {
		return this.view?.visible ?? false;
	}

	// ── Toggle logic: sidebar view or compact panel fallback ─────────────

	async toggleSidebar(): Promise<void> {
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
	}

	async openPrimaryView(): Promise<void> {
		const desiredPlacement = this.getStoredPlacement();
		if (desiredPlacement === 'panel-beside') {
			this.openPanel();
			return;
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
			return;
		}

		this.panel = new PasteboardPanel(this.ctx, {
			viewType: PANEL_VIEW_TYPE,
			title: 'Pasteboard',
			buildHtml: webview => this.buildHtml(webview),
			onDidReceiveMessage: msg => {
				void this.handleMessage(msg as WebviewToHostMessage);
			},
			onDidDispose: () => {
				void this.flushDraft();
				this.panel = undefined;
			},
			extensionUri: this.ctx.extensionUri
		});

		this.attachWebview(this.panel.webview, this.panel.webview.options);
		void this.updatePlacement('panel-beside');
	}

	closePanel(): void {
		this.panel?.dispose();
		this.panel = undefined;
	}

	isPanelOpen(): boolean {
		return this.panel !== undefined;
	}

	deserializePanel(panel: vscode.WebviewPanel): void {
		this.panel = new PasteboardPanel(this.ctx, {
			viewType: PANEL_VIEW_TYPE,
			title: panel.title,
			buildHtml: webview => this.buildHtml(webview),
			onDidReceiveMessage: msg => {
				void this.handleMessage(msg as WebviewToHostMessage);
			},
			onDidDispose: () => {
				void this.flushDraft();
				this.panel = undefined;
			},
			extensionUri: this.ctx.extensionUri
		});
		this.attachWebview(this.panel.webview, this.panel.webview.options);
	}

	private closeAll(): void {
		if (this.panel) {
			this.panel.dispose();
			this.panel = undefined;
		}
		if (this.view) {
			this.view = undefined;
		}
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
		this.broadcastState();
	}

	async newItem(): Promise<void> {
		this.uiState.selectedItemId = null;
		this.setDraft(this.uiState.activeTab, { title: '', content: '' });
		this.broadcastState();
		this.postCommandToWebviews('new');
	}

	async saveItem(): Promise<void> {
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

		webview.onDidReceiveMessage((msg: WebviewToHostMessage) => {
			void this.handleMessage(msg);
		});
	}

	private detachWebview(webview: vscode.Webview): void {
		this.webviews.delete(webview);
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
			<button id="btn-autosave" type="button" class="icon-btn" tabindex="0" aria-label="Toggle autosave" aria-pressed="true" title="Toggle autosave">
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<path d="M3 12a9 9 0 0 1 15-6.7L20 7" />
					<path d="M20 3v4h-4" />
					<path d="M21 12a9 9 0 0 1-15 6.7L4 17" />
					<path d="M4 21v-4h4" />
				</svg>
			</button>
			<button id="btn-new" type="button" class="icon-btn" tabindex="0" aria-label="New note" title="New note">
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<path d="M13.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5L13.5 3Z" />
					<path d="M13 3v5a1 1 0 0 0 1 1h5" />
					<path d="M12 12v6M9 15h6" />
				</svg>
			</button>
			<button id="btn-pin" type="button" class="icon-btn" tabindex="0" aria-label="Pin or unpin" aria-pressed="false" title="Pin or unpin" disabled>
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<path d="M9 4h6" />
					<path d="M11 4v5.5a2 2 0 0 1-.9 1.67l-2.2 1.47A1.5 1.5 0 0 0 7 14h10a1.5 1.5 0 0 0-.9-1.36l-2.2-1.47A2 2 0 0 1 13 9.5V4" />
					<path d="M12 14v6" />
				</svg>
			</button>
			<button id="btn-save" type="button" class="icon-btn" tabindex="0" aria-label="Save note" title="Save note">
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<path d="M17.5 21H6.5A1.5 1.5 0 0 1 5 19.5v-15A1.5 1.5 0 0 1 6.5 3h9.086a1.5 1.5 0 0 1 1.06.44l2.914 2.914a1.5 1.5 0 0 1 .44 1.06V19.5a1.5 1.5 0 0 1-1.5 1.5Z" />
					<path d="M8 3v5h7V3" />
					<path d="M8 21v-7h8v7" />
				</svg>
			</button>
			<button id="btn-panel" type="button" class="icon-btn" tabindex="0" aria-label="Toggle panel view" title="Toggle panel view">
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<rect x="3" y="4" width="18" height="16" rx="2" />
					<path d="M15 4v16" />
				</svg>
			</button>
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
		<input id="search" type="search" placeholder="Search saved items…" aria-label="Search items" tabindex="3" />
		<ul id="item-list" class="item-list" role="listbox" aria-label="Saved items"></ul>
		<p id="empty-state" class="empty-state" hidden>No saved items yet.</p>
	</footer>

	<script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
	}

	// ── Message handling ─────────────────────────────────────────────────

	private async handleMessage(msg: WebviewToHostMessage): Promise<void> {
		try {
			switch (msg.type) {
				case 'ready':
					this.sendInit();
					break;
				case 'switchTab':
					this.uiState.activeTab = msg.tabId;
					this.uiState.selectedItemId = null;
					this.broadcastState();
					break;
				case 'selectItem':
					await this.flushDraft();
					this.uiState.activeTab = msg.tabId;
					this.uiState.selectedItemId = msg.itemId;
					if (msg.itemId) {
						const item = this.storage.getItems(msg.tabId).find(i => i.id === msg.itemId);
						if (item) {
							this.setDraft(msg.tabId, { title: item.title, content: item.content });
						}
					} else {
						this.setDraft(msg.tabId, { title: '', content: '' });
					}
					this.broadcastState();
					this.postCommandToWebviews('focusEditor');
					break;
				case 'draftChange':
					this.uiState.activeTab = msg.tabId;
					this.uiState.selectedItemId = msg.itemId;
					this.setDraft(msg.tabId, { title: msg.title, content: msg.content });
					break;
				case 'createItem':
					await this.persistCreate(msg.tabId, msg.title, msg.content);
					break;
				case 'updateItem':
					await this.persistUpdate(msg.tabId, msg.item);
					break;
				case 'autosave': {
					// Only ack when something was actually written — an empty draft is a no-op in persistDraft.
					const saved = await this.persistDraft(msg.tabId, msg.itemId, msg.title, msg.content, true);
					if (saved) {
						this.postToAll({
							type: 'autosaveAck',
							itemId: this.uiState.selectedItemId,
							savedAt: Date.now()
						});
					}
					break;
				}
				case 'deleteItem':
					await this.persistDelete(msg.tabId, msg.itemId);
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
					await vscode.commands.executeCommand('setContext', 'pasteboardFocused', true);
					break;
				case 'blur':
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

	private async persistDelete(tabId: TabScope, itemId: string): Promise<void> {
		const confirmDelete = vscode.workspace
			.getConfiguration('pasteboard')
			.get<boolean>('confirmDelete', true);

		if (confirmDelete) {
			const item = this.storage.getItems(tabId).find(i => i.id === itemId);
			const answer = await vscode.window.showWarningMessage(
				`Delete "${item?.title ?? 'this item'}" from Pasteboard?`,
				{ modal: true },
				'Delete'
			);
			if (answer !== 'Delete') {
				return;
			}
		}

		const items = this.storage.getItems(tabId).filter(i => i.id !== itemId);
		await this.storage.setItems(tabId, items);

		if (this.uiState.selectedItemId === itemId) {
			this.uiState.selectedItemId = null;
			this.setDraft(tabId, { title: '', content: '' });
		}
		this.broadcastState();
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

	private sendInit(): void {
		const tabs = this.storage.getWorkspaceTabs();
		if (this.uiState.activeTab !== 'global' && !tabs.some(t => t.id === this.uiState.activeTab)) {
			this.uiState.activeTab = tabs[0]?.id ?? 'global';
		}

		const message: HostToWebviewMessage = {
			type: 'init',
			tabs,
			activeTab: this.uiState.activeTab,
			items: this.storage.getItems(this.uiState.activeTab),
			selectedItemId: this.uiState.selectedItemId,
			draft: this.getDraft(this.uiState.activeTab),
			settings: this.getUiSettings()
		};
		this.postToAll(message);
	}

	private broadcastState(): void {
		const message: HostToWebviewMessage = {
			type: 'stateUpdate',
			activeTab: this.uiState.activeTab,
			items: this.storage.getItems(this.uiState.activeTab),
			selectedItemId: this.uiState.selectedItemId,
			draft: this.getDraft(this.uiState.activeTab)
		};
		this.postToAll(message);
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
			void webview.postMessage(message);
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
