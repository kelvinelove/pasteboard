/** A single saved note/snippet in Pasteboard. */
export interface PasteboardItem {
	id: string;
	title: string;
	content: string;
	createdAt: number;
	updatedAt: number;
	pinned: boolean;
}

/** Scope identifier: global or a specific workspace folder URI. */
export type TabScope = 'global' | string;

export interface WorkspaceTabInfo {
	id: TabScope;
	label: string;
	uri?: string;
}

/** User-facing settings pushed to the webview on init / config change. */
export interface PasteboardUiSettings {
	confirmDelete: boolean;
	autosave: boolean;
	autosaveDelay: number;
	editorBorder: string | boolean;
}

/** Messages sent from the webview to the extension host. */
export type WebviewToHostMessage =
	| { type: 'ready' }
	| { type: 'switchTab'; tabId: TabScope }
	| { type: 'selectItem'; tabId: TabScope; itemId: string | null }
	| { type: 'createItem'; tabId: TabScope; title: string; content: string }
	| { type: 'updateItem'; tabId: TabScope; item: PasteboardItem }
	| { type: 'autosave'; tabId: TabScope; itemId: string | null; title: string; content: string }
	| { type: 'deleteItem'; tabId: TabScope; itemId: string }
	| { type: 'togglePin'; tabId: TabScope; itemId: string }
	| { type: 'draftChange'; tabId: TabScope; itemId: string | null; title: string; content: string }
	| { type: 'setAutosave'; enabled: boolean }
	| { type: 'togglePanel' }
	| { type: 'focus' }
	| { type: 'blur' };

/** Messages sent from the extension host to the webview. */
export type HostToWebviewMessage =
	| {
			type: 'init';
			tabs: WorkspaceTabInfo[];
			activeTab: TabScope;
			items: PasteboardItem[];
			selectedItemId: string | null;
			draft: { title: string; content: string };
			settings: PasteboardUiSettings;
	  }
	| {
			type: 'stateUpdate';
			activeTab: TabScope;
			items: PasteboardItem[];
			selectedItemId: string | null;
			draft: { title: string; content: string };
	  }
	| { type: 'settingsUpdate'; settings: PasteboardUiSettings }
	| { type: 'command'; command: 'new' | 'save' | 'delete' | 'openGlobal' | 'focusEditor' }
	| { type: 'error'; message: string }
	/** Sent after the host actually persists an autosave, so the webview can confirm real (not optimistic) save state. */
	| { type: 'autosaveAck'; itemId: string | null; savedAt: number };
