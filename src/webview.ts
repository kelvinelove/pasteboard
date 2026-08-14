/**
 * Pasteboard webview client — typing-first layout with bottom item list,
 * debounced autosave, and hover-delete controls.
 */

declare function acquireVsCodeApi(): {
	postMessage(message: unknown): void;
	getState(): unknown;
	setState(state: unknown): void;
};

interface PasteboardItem {
	id: string;
	title: string;
	content: string;
	createdAt: number;
	updatedAt: number;
	pinned: boolean;
}

interface WorkspaceTabInfo {
	id: string;
	label: string;
	uri?: string;
}

interface UiSettings {
	confirmDelete: boolean;
	autosave: boolean;
	autosaveDelay: number;
	editorBorder: string | boolean;
}

type HostMessage =
	| {
			type: 'init';
			tabs: WorkspaceTabInfo[];
			activeTab: string;
			items: PasteboardItem[];
			selectedItemId: string | null;
			draft: { title: string; content: string };
			settings: UiSettings;
	  }
	| {
			type: 'stateUpdate';
			activeTab: string;
			items: PasteboardItem[];
			selectedItemId: string | null;
			draft: { title: string; content: string };
	  }
	| { type: 'settingsUpdate'; settings: UiSettings }
	| { type: 'command'; command: 'new' | 'save' | 'delete' | 'openGlobal' | 'focusEditor' }
	| { type: 'error'; message: string }
	| { type: 'autosaveAck'; itemId: string | null; savedAt: number };

const vscode = acquireVsCodeApi();

const tabsEl = document.getElementById('tabs')!;
const searchEl = document.getElementById('search') as HTMLInputElement;
const itemListEl = document.getElementById('item-list')!;
const emptyStateEl = document.getElementById('empty-state')!;
const titleInput = document.getElementById('title-input') as HTMLInputElement;
const contentInput = document.getElementById('content-input') as HTMLTextAreaElement;
const editorFrame = document.getElementById('editor-frame')!;
const autosaveIndicator = document.getElementById('autosave-indicator')!;
const btnAutosave = document.getElementById('btn-autosave') as HTMLButtonElement;
const btnNew = document.getElementById('btn-new') as HTMLButtonElement;
const btnSave = document.getElementById('btn-save') as HTMLButtonElement;
const btnPin = document.getElementById('btn-pin') as HTMLButtonElement;
const btnPanel = document.getElementById('btn-panel') as HTMLButtonElement;

const ICON_STROKE = 'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';

const ICONS = {
	autosaveOn: `<svg width="16" height="16" viewBox="0 0 24 24" ${ICON_STROKE} aria-hidden="true"><path d="M3 12a9 9 0 0 1 15-6.7L20 7"/><path d="M20 3v4h-4"/><path d="M21 12a9 9 0 0 1-15 6.7L4 17"/><path d="M4 21v-4h4"/></svg>`,
	autosaveOff: `<svg width="16" height="16" viewBox="0 0 24 24" ${ICON_STROKE} aria-hidden="true"><path d="M3 12a9 9 0 0 1 15-6.7L20 7"/><path d="M20 3v4h-4"/><path d="M21 12a9 9 0 0 1-15 6.7L4 17"/><path d="M4 21v-4h4"/><line x1="4" y1="4" x2="20" y2="20" opacity="0.6"/></svg>`,
	pinOn: `<svg width="16" height="16" viewBox="0 0 24 24" ${ICON_STROKE} aria-hidden="true"><path d="M9 4h6"/><path d="M11 4v5.5a2 2 0 0 1-.9 1.67l-2.2 1.47A1.5 1.5 0 0 0 7 14h10a1.5 1.5 0 0 0-.9-1.36l-2.2-1.47A2 2 0 0 1 13 9.5V4" fill="currentColor" fill-opacity="0.35"/><path d="M12 14v6"/></svg>`,
	pinOff: `<svg width="16" height="16" viewBox="0 0 24 24" ${ICON_STROKE} aria-hidden="true"><path d="M9 4h6"/><path d="M11 4v5.5a2 2 0 0 1-.9 1.67l-2.2 1.47A1.5 1.5 0 0 0 7 14h10a1.5 1.5 0 0 0-.9-1.36l-2.2-1.47A2 2 0 0 1 13 9.5V4"/><path d="M12 14v6"/></svg>`,
	deleteItem: `<svg width="14" height="14" viewBox="0 0 24 24" ${ICON_STROKE} aria-hidden="true"><path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13"/><path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3"/></svg>`
};

let activeTab = 'global';
let selectedItemId: string | null = null;
let items: PasteboardItem[] = [];
let cachedTabs: WorkspaceTabInfo[] = [];
let searchQuery = '';
let suppressDraftPost = false;

let settings: UiSettings = {
	confirmDelete: true,
	autosave: true,
	autosaveDelay: 1000,
	editorBorder: '1px'
};

let autosaveTimer: ReturnType<typeof setTimeout> | null = null;

function post(message: Record<string, unknown>): void {
	vscode.postMessage(message);
}

function sanitizeText(value: string): string {
	return value.replace(/\u0000/g, '').trim();
}

function applySettings(s: UiSettings): void {
	settings = s;
	btnAutosave.classList.toggle('active', s.autosave);
	btnAutosave.setAttribute('aria-pressed', String(s.autosave));
	btnAutosave.title = s.autosave ? 'Autosave on (click to disable)' : 'Autosave off (click to enable)';
	btnAutosave.setAttribute('aria-label', btnAutosave.title);
	btnAutosave.innerHTML = s.autosave ? ICONS.autosaveOn : ICONS.autosaveOff;
	applyEditorBorder(s.editorBorder);
}

function applyEditorBorder(border: string | boolean): void {
	if (border === false || border === '0' || border === '0px' || border === 'none') {
		(editorFrame as HTMLElement).style.border = 'none';
		return;
	}
	const width = typeof border === 'string' ? border : '1px';
	(editorFrame as HTMLElement).style.border =
		`${width} solid var(--vscode-editorWidget-border, var(--vscode-panel-border, var(--vscode-editor-foreground)))`;
}

function setAutosaveIndicator(state: 'idle' | 'pending' | 'saved'): void {
	switch (state) {
		case 'pending':
			autosaveIndicator.textContent = settings.autosave ? 'Saving…' : '';
			break;
		case 'saved':
			autosaveIndicator.textContent = settings.autosave ? 'Saved' : '';
			setTimeout(() => {
				if (autosaveIndicator.textContent === 'Saved') {
					autosaveIndicator.textContent = settings.autosave ? 'Autosave on' : '';
				}
			}, 1500);
			break;
		default:
			autosaveIndicator.textContent = settings.autosave ? 'Autosave on' : '';
	}
}

/** Host confirmed the autosave actually persisted; attach the real timestamp as a tooltip over the optimistic "Saved" text. */
function handleAutosaveAck(savedAt: number): void {
	autosaveIndicator.title = `Saved at ${new Date(savedAt).toLocaleTimeString()}`;
}

function filteredItems(): PasteboardItem[] {
	const q = searchQuery.trim().toLowerCase();
	if (!q) {
		return items;
	}
	return items.filter(
		i => i.title.toLowerCase().includes(q) || i.content.toLowerCase().includes(q)
	);
}

function renderTabs(tabs: WorkspaceTabInfo[]): void {
	tabsEl.innerHTML = '';
	for (const tab of tabs) {
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'tab' + (tab.id === activeTab ? ' active' : '');
		btn.textContent = tab.label;
		btn.setAttribute('role', 'tab');
		btn.setAttribute('aria-selected', String(tab.id === activeTab));
		btn.addEventListener('click', () => {
			post({ type: 'switchTab', tabId: tab.id });
		});
		tabsEl.appendChild(btn);
	}
}

function deleteItemById(itemId: string): void {
	post({ type: 'deleteItem', tabId: activeTab, itemId });
}

function renderItemList(): void {
	const visible = filteredItems();
	itemListEl.innerHTML = '';

	const sorted = [...visible].sort((a, b) => {
		if (a.pinned !== b.pinned) {
			return a.pinned ? -1 : 1;
		}
		return b.updatedAt - a.updatedAt;
	});

	for (const item of sorted) {
		const li = document.createElement('li');
		li.className =
			'item' +
			(item.id === selectedItemId ? ' selected' : '') +
			(item.pinned ? ' pinned' : '');
		li.setAttribute('role', 'option');
		li.setAttribute('aria-selected', String(item.id === selectedItemId));
		li.tabIndex = 0;

		const textWrap = document.createElement('div');
		textWrap.className = 'item-text';

		const titleSpan = document.createElement('span');
		titleSpan.className = 'item-title';
		titleSpan.textContent = item.title || 'Untitled';
		if (item.pinned) {
			titleSpan.textContent = `📌 ${titleSpan.textContent}`;
		}

		const metaSpan = document.createElement('span');
		metaSpan.className = 'item-meta';
		metaSpan.textContent = new Date(item.updatedAt).toLocaleString([], {
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit'
		});

		const deleteBtn = document.createElement('button');
		deleteBtn.type = 'button';
		deleteBtn.className = 'item-delete';
		deleteBtn.setAttribute('aria-label', `Delete ${item.title || 'Untitled'}`);
		deleteBtn.title = 'Delete';
		deleteBtn.innerHTML = ICONS.deleteItem;
		deleteBtn.addEventListener('click', e => {
			e.stopPropagation();
			deleteItemById(item.id);
		});

		textWrap.appendChild(titleSpan);
		textWrap.appendChild(metaSpan);
		li.appendChild(textWrap);
		li.appendChild(deleteBtn);

		li.addEventListener('click', () => {
			post({ type: 'selectItem', tabId: activeTab, itemId: item.id });
		});

		li.addEventListener('keydown', e => {
			if (e.key === 'Delete' || e.key === 'Backspace') {
				e.preventDefault();
				deleteItemById(item.id);
			} else if (e.key === 'Enter') {
				post({ type: 'selectItem', tabId: activeTab, itemId: item.id });
			}
		});

		itemListEl.appendChild(li);
	}

	emptyStateEl.hidden = sorted.length > 0;
}

function applyDraft(draft: { title: string; content: string }, focusEditor = false): void {
	suppressDraftPost = true;
	titleInput.value = draft.title;
	contentInput.value = draft.content;
	suppressDraftPost = false;
	if (focusEditor) {
		contentInput.focus();
	}
}

function applyState(
	msg: Extract<HostMessage, { type: 'init' | 'stateUpdate' }>,
	focusEditor = false
): void {
	activeTab = msg.activeTab;
	selectedItemId = msg.selectedItemId;
	items = msg.items;
	applyDraft(msg.draft, focusEditor);
	if (cachedTabs.length > 0) {
		renderTabs(cachedTabs);
	}
	renderItemList();
	updatePinButton();
}

function updatePinButton(): void {
	if (!selectedItemId) {
		btnPin.setAttribute('disabled', 'true');
		btnPin.setAttribute('aria-pressed', 'false');
		btnPin.title = 'Pin/unpin';
		btnPin.setAttribute('aria-label', btnPin.title);
		btnPin.classList.remove('active');
		btnPin.innerHTML = ICONS.pinOff;
		return;
	}
	btnPin.removeAttribute('disabled');
	const item = items.find(i => i.id === selectedItemId);
	const pinned = item?.pinned ?? false;
	btnPin.title = pinned ? 'Unpin' : 'Pin';
	btnPin.setAttribute('aria-label', btnPin.title);
	btnPin.setAttribute('aria-pressed', String(pinned));
	btnPin.classList.toggle('active', pinned);
	btnPin.innerHTML = pinned ? ICONS.pinOn : ICONS.pinOff;
}

function postDraftChange(): void {
	if (suppressDraftPost) {
		return;
	}
	post({
		type: 'draftChange',
		tabId: activeTab,
		itemId: selectedItemId,
		title: sanitizeText(titleInput.value),
		content: sanitizeText(contentInput.value)
	});
	scheduleAutosave();
}

function scheduleAutosave(): void {
	if (!settings.autosave) {
		return;
	}
	if (autosaveTimer) {
		clearTimeout(autosaveTimer);
	}
	setAutosaveIndicator('pending');
	// Debounce user typing: restart the idle timer on every keystroke, clamped defensively
	// even though the host already clamps pasteboard.autosaveDelay to the same [250, 10000] range.
	const delay = Math.min(10000, Math.max(250, settings.autosaveDelay));
	autosaveTimer = setTimeout(() => {
		handleSave(true);
	}, delay);
}

function handleNew(): void {
	if (autosaveTimer) {
		clearTimeout(autosaveTimer);
	}
	selectedItemId = null;
	titleInput.value = '';
	contentInput.value = '';
	contentInput.focus();
	post({ type: 'selectItem', tabId: activeTab, itemId: null });
}

function handleSave(isAutosave = false): void {
	const title = sanitizeText(titleInput.value);
	const content = sanitizeText(contentInput.value);

	if (!title.trim() && !content.trim()) {
		return;
	}

	if (isAutosave) {
		post({
			type: 'autosave',
			tabId: activeTab,
			itemId: selectedItemId,
			title,
			content
		});
		setAutosaveIndicator('saved');
		return;
	}

	if (selectedItemId) {
		const existing = items.find(i => i.id === selectedItemId);
		if (existing) {
			post({
				type: 'updateItem',
				tabId: activeTab,
				item: { ...existing, title, content }
			});
			setAutosaveIndicator('saved');
			return;
		}
	}

	post({ type: 'createItem', tabId: activeTab, title, content });
	setAutosaveIndicator('saved');
}

function handlePin(): void {
	if (!selectedItemId) {
		return;
	}
	post({ type: 'togglePin', tabId: activeTab, itemId: selectedItemId });
}

// ── Event listeners ────────────────────────────────────────────────────

btnAutosave.addEventListener('click', () => {
	post({ type: 'setAutosave', enabled: !settings.autosave });
});

btnNew.addEventListener('click', handleNew);
btnSave.addEventListener('click', () => handleSave(false));
btnPin.addEventListener('click', handlePin);
btnPanel.addEventListener('click', () => post({ type: 'togglePanel' }));

titleInput.addEventListener('input', postDraftChange);
contentInput.addEventListener('input', postDraftChange);

searchEl.addEventListener('input', () => {
	searchQuery = searchEl.value;
	renderItemList();
});

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
	const msg = event.data;
	switch (msg.type) {
		case 'init':
			cachedTabs = msg.tabs;
			applySettings(msg.settings);
			renderTabs(msg.tabs);
			applyState(msg);
			break;
		case 'stateUpdate':
			applyState(msg);
			break;
		case 'settingsUpdate':
			applySettings(msg.settings);
			break;
		case 'command':
			switch (msg.command) {
				case 'new':
					handleNew();
					break;
				case 'save':
					handleSave(false);
					break;
				case 'openGlobal':
					post({ type: 'switchTab', tabId: 'global' });
					break;
				case 'focusEditor':
					contentInput.focus();
					break;
			}
			break;
		case 'error':
			console.error('[Pasteboard]', msg.message);
			break;
		case 'autosaveAck':
			handleAutosaveAck(msg.savedAt);
			break;
	}
});

window.addEventListener('focus', () => post({ type: 'focus' }));
window.addEventListener('blur', () => {
	if (autosaveTimer) {
		clearTimeout(autosaveTimer);
		handleSave(true);
	}
	post({ type: 'blur' });
});

document.addEventListener('visibilitychange', () => {
	if (document.hidden && settings.autosave) {
		if (autosaveTimer) {
			clearTimeout(autosaveTimer);
		}
		handleSave(true);
	}
});

post({ type: 'ready' });
post({ type: 'focus' });
