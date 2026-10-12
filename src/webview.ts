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
	count?: number;
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
			tabs: WorkspaceTabInfo[];
			activeTab: string;
			items: PasteboardItem[];
			selectedItemId: string | null;
			draft: { title: string; content: string };
	  }
	| { type: 'settingsUpdate'; settings: UiSettings }
	| { type: 'command'; command: 'new' | 'save' | 'delete' | 'openGlobal' | 'focusEditor' }
	| { type: 'error'; message: string }
	| { type: 'autosaveAck'; itemId: string | null; savedAt: number; revision: number }
	| { type: 'itemDeleted'; tabId: string; item: PasteboardItem };

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
const btnDuplicate = document.getElementById('btn-duplicate') as HTMLButtonElement;
const btnPanel = document.getElementById('btn-panel') as HTMLButtonElement;
const undoToastEl = document.getElementById('undo-toast') as HTMLElement;
const undoToastTextEl = document.getElementById('undo-toast-text')!;
const undoToastBtn = document.getElementById('undo-toast-btn') as HTMLButtonElement;

const ICON_STROKE = 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';

const ICONS = {
	autosaveOn: `<svg width="18" height="18" viewBox="0 0 24 24" ${ICON_STROKE} aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.9-4M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.9 4M20 20v-4h-4"/></svg>`,
	autosaveOff: `<svg width="18" height="18" viewBox="0 0 24 24" ${ICON_STROKE} aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.9-4M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.9 4M20 20v-4h-4"/><path d="m4 4 16 16"/></svg>`,
	pinOn: `<svg width="18" height="18" viewBox="0 0 24 24" ${ICON_STROKE} aria-hidden="true"><path d="M9 4h6M10 4v5l-3.5 3.5V14h11v-1.5L14 9V4M12 14v6" fill="currentColor" fill-opacity="0.18"/><path d="M9 4h6M10 4v5l-3.5 3.5V14h11v-1.5L14 9V4M12 14v6"/></svg>`,
	pinOff: `<svg width="18" height="18" viewBox="0 0 24 24" ${ICON_STROKE} aria-hidden="true"><path d="M9 4h6M10 4v5l-3.5 3.5V14h11v-1.5L14 9V4M12 14v6"/></svg>`,
	deleteItem: `<svg width="14" height="14" viewBox="0 0 24 24" ${ICON_STROKE} aria-hidden="true"><path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13"/><path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3"/></svg>`
};

// Native `title` tooltips don't reliably render inside this webview, so tooltips are
// implemented here instead: any element with a `data-tooltip` attribute gets one via
// delegated hover/focus listeners, positioned in fixed coordinates (so it isn't clipped
// by the scrolling item list) and flipped above/below depending on available space.
const tooltipEl = document.createElement('div');
tooltipEl.className = 'hover-tooltip';
tooltipEl.setAttribute('role', 'tooltip');
document.body.appendChild(tooltipEl);

let tooltipShowTimer: ReturnType<typeof setTimeout> | null = null;

function hideTooltip(): void {
	if (tooltipShowTimer) {
		clearTimeout(tooltipShowTimer);
		tooltipShowTimer = null;
	}
	tooltipEl.classList.remove('visible');
}

function showTooltipFor(target: HTMLElement): void {
	const text = target.getAttribute('data-tooltip');
	if (!text) {
		return;
	}
	tooltipEl.textContent = text;
	tooltipEl.classList.add('visible');

	const anchor = target.getBoundingClientRect();
	const bubble = tooltipEl.getBoundingClientRect();
	const fitsBelow = anchor.bottom + bubble.height + 6 <= window.innerHeight;
	const top = fitsBelow ? anchor.bottom + 6 : anchor.top - bubble.height - 6;
	const left = Math.min(
		Math.max(4, anchor.left + anchor.width / 2 - bubble.width / 2),
		window.innerWidth - bubble.width - 4
	);
	tooltipEl.style.top = `${Math.max(4, top)}px`;
	tooltipEl.style.left = `${left}px`;
}

function scheduleTooltip(target: HTMLElement): void {
	hideTooltip();
	tooltipShowTimer = setTimeout(() => showTooltipFor(target), 350);
}

document.addEventListener('mouseover', e => {
	const target = (e.target as HTMLElement).closest<HTMLElement>('[data-tooltip]');
	if (target) {
		scheduleTooltip(target);
	}
});
document.addEventListener('mouseout', e => {
	if ((e.target as HTMLElement).closest('[data-tooltip]')) {
		hideTooltip();
	}
});
document.addEventListener('focusin', e => {
	const target = (e.target as HTMLElement).closest<HTMLElement>('[data-tooltip]');
	if (target) {
		showTooltipFor(target);
	}
});
document.addEventListener('focusout', e => {
	if ((e.target as HTMLElement).closest('[data-tooltip]')) {
		hideTooltip();
	}
});
document.addEventListener('mousedown', hideTooltip);
itemListEl.addEventListener('scroll', hideTooltip);

let activeTab = 'global';
let selectedItemId: string | null = null;
let items: PasteboardItem[] = [];
let searchQuery = '';
let suppressDraftPost = false;

let settings: UiSettings = {
	confirmDelete: true,
	autosave: true,
	autosaveDelay: 1000,
	editorBorder: '1px'
};

let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
let draftRevision = 0;
let pendingRevision = 0;

function post(message: Record<string, unknown>): void {
	vscode.postMessage(message);
}

function sanitizeText(value: string): string {
	return value.replace(/\u0000/g, '');
}

function applySettings(s: UiSettings): void {
	settings = s;
	btnAutosave.classList.toggle('active', s.autosave);
	btnAutosave.setAttribute('aria-pressed', String(s.autosave));
	const label = s.autosave ? 'Autosave enabled (click to disable)' : 'Autosave disabled (click to enable)';
	btnAutosave.setAttribute('data-tooltip', label);
	btnAutosave.setAttribute('aria-label', label);
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

function setAutosaveIndicator(state: 'idle' | 'pending' | 'saved' | 'unsaved' | 'error'): void {
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
		case 'unsaved':
			autosaveIndicator.textContent = 'Unsaved · autosave off';
			break;
		case 'error':
			autosaveIndicator.textContent = 'Save failed';
			break;
		default:
			autosaveIndicator.textContent = settings.autosave ? 'Autosave on' : '';
	}
}

/** Host confirmed the autosave actually persisted; attach the real timestamp as a tooltip over the optimistic "Saved" text. */
function handleAutosaveAck(savedAt: number): void {
	autosaveIndicator.setAttribute('data-tooltip', `Saved at ${new Date(savedAt).toLocaleTimeString()}`);
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

		const labelSpan = document.createElement('span');
		labelSpan.textContent = tab.label;
		btn.appendChild(labelSpan);
		if (tab.count) {
			const countSpan = document.createElement('span');
			countSpan.className = 'tab-count';
			countSpan.textContent = String(tab.count);
			btn.appendChild(countSpan);
		}

		const tabTooltip = `Switch to ${tab.label}`;
		btn.setAttribute('data-tooltip', tabTooltip);
		btn.setAttribute('aria-label', tabTooltip);
		btn.setAttribute('role', 'tab');
		btn.setAttribute('aria-selected', String(tab.id === activeTab));
		btn.tabIndex = tab.id === activeTab ? 0 : -1;
		btn.addEventListener('click', () => {
			post({ type: 'switchTab', tabId: tab.id });
		});
		btn.addEventListener('keydown', e => {
			if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') {
				return;
			}
			e.preventDefault();
			const next = e.key === 'ArrowRight' ? btn.nextElementSibling : btn.previousElementSibling;
			(next as HTMLButtonElement | null)?.focus();
			(next as HTMLButtonElement | null)?.click();
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

		const previewSpan = document.createElement('span');
		previewSpan.className = 'item-preview';
		const normalizedContent = item.content.slice(0, 512).replace(/\s+/g, ' ').trim();
		previewSpan.textContent = normalizedContent.length > 180
			? `${normalizedContent.slice(0, 180).trimEnd()}…`
			: normalizedContent;

		const deleteBtn = document.createElement('button');
		deleteBtn.type = 'button';
		deleteBtn.className = 'item-delete';
		deleteBtn.setAttribute('aria-label', `Delete ${item.title || 'Untitled'}`);
		deleteBtn.setAttribute('data-tooltip', 'Delete');
		deleteBtn.innerHTML = ICONS.deleteItem;
		deleteBtn.addEventListener('click', e => {
			e.stopPropagation();
			deleteItemById(item.id);
		});

		textWrap.appendChild(titleSpan);
		if (previewSpan.textContent) {
			textWrap.appendChild(previewSpan);
		}
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
			} else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
				e.preventDefault();
				const next = e.key === 'ArrowDown' ? li.nextElementSibling : li.previousElementSibling;
				(next as HTMLElement | null)?.focus();
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
	draftRevision += 1;
	applyDraft(msg.draft, focusEditor);
	renderTabs(msg.tabs);
	renderItemList();
	updatePinButton();
	updateDuplicateButton();
}

function updatePinButton(): void {
	if (!selectedItemId) {
		btnPin.setAttribute('disabled', 'true');
		btnPin.setAttribute('aria-pressed', 'false');
		btnPin.setAttribute('data-tooltip', 'Pin/unpin');
		btnPin.setAttribute('aria-label', 'Pin/unpin');
		btnPin.classList.remove('active');
		btnPin.innerHTML = ICONS.pinOff;
		return;
	}
	btnPin.removeAttribute('disabled');
	const item = items.find(i => i.id === selectedItemId);
	const pinned = item?.pinned ?? false;
	const pinLabel = pinned ? 'Unpin' : 'Pin';
	btnPin.setAttribute('data-tooltip', pinLabel);
	btnPin.setAttribute('aria-label', pinLabel);
	btnPin.setAttribute('aria-pressed', String(pinned));
	btnPin.classList.toggle('active', pinned);
	btnPin.innerHTML = pinned ? ICONS.pinOn : ICONS.pinOff;
}

function updateDuplicateButton(): void {
	btnDuplicate.disabled = !selectedItemId;
}

function postDraftChange(): void {
	if (suppressDraftPost) {
		return;
	}
	draftRevision += 1;
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
		setAutosaveIndicator('unsaved');
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
	const revision = draftRevision;
	pendingRevision = revision;
	if (isAutosave) {
		setAutosaveIndicator('pending');
	}

	if (isAutosave) {
		post({
			type: 'autosave',
			tabId: activeTab,
			itemId: selectedItemId,
			title,
			content,
			revision
		});
		return;
	}

	if (selectedItemId) {
		const existing = items.find(i => i.id === selectedItemId);
		if (existing) {
			post({
				type: 'updateItem',
				tabId: activeTab,
				item: { ...existing, title, content },
				revision
			});
			setAutosaveIndicator('pending');
			return;
		}
	}

	post({ type: 'createItem', tabId: activeTab, title, content, revision });
	setAutosaveIndicator('pending');
}

function handlePin(): void {
	if (!selectedItemId) {
		return;
	}
	post({ type: 'togglePin', tabId: activeTab, itemId: selectedItemId });
}

function handleDuplicate(): void {
	if (!selectedItemId) {
		return;
	}
	post({ type: 'duplicateItem', tabId: activeTab, itemId: selectedItemId });
}

// ── Undo-delete toast ──────────────────────────────────────────────────

let pendingUndo: { tabId: string; itemId: string } | null = null;
let undoHideTimer: ReturnType<typeof setTimeout> | null = null;

function hideUndoToast(): void {
	undoToastEl.hidden = true;
	pendingUndo = null;
	if (undoHideTimer) {
		clearTimeout(undoHideTimer);
		undoHideTimer = null;
	}
}

function showUndoToast(tabId: string, item: PasteboardItem): void {
	pendingUndo = { tabId, itemId: item.id };
	undoToastTextEl.textContent = `Deleted "${item.title || 'Untitled'}"`;
	undoToastEl.hidden = false;
	if (undoHideTimer) {
		clearTimeout(undoHideTimer);
	}
	undoHideTimer = setTimeout(hideUndoToast, 6000);
}

undoToastBtn.addEventListener('click', () => {
	if (!pendingUndo) {
		return;
	}
	post({ type: 'undoDelete', tabId: pendingUndo.tabId, itemId: pendingUndo.itemId });
	hideUndoToast();
});

// ── Event listeners ────────────────────────────────────────────────────

btnAutosave.addEventListener('click', () => {
	post({ type: 'setAutosave', enabled: !settings.autosave });
});

btnNew.addEventListener('click', handleNew);
btnSave.addEventListener('click', () => handleSave(false));
btnPin.addEventListener('click', handlePin);
btnDuplicate.addEventListener('click', handleDuplicate);
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
			applySettings(msg.settings);
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
			setAutosaveIndicator('error');
			break;
		case 'autosaveAck':
			if (msg.revision === pendingRevision) {
				setAutosaveIndicator('saved');
				handleAutosaveAck(msg.savedAt);
			}
			break;
		case 'itemDeleted':
			showUndoToast(msg.tabId, msg.item);
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

post({ type: 'ready', viewportWidth: window.innerWidth });
post({ type: 'focus' });
