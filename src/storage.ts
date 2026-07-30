import * as vscode from 'vscode';
import { PasteboardItem, TabScope, WorkspaceTabInfo } from './types';

/** Keys used for persistence in Memento storage. */
const GLOBAL_KEY = 'pasteboard.global';
const WORKSPACE_PREFIX = 'pasteboard.workspace.';
const LEGACY_WORKSPACE_KEY = 'workspace-notepad';
const LEGACY_ITEMS_KEY = 'workspace-notepad.notes';

/**
 * Manages reading/writing PasteboardItem arrays for global and per-folder scopes.
 * Workspace items live in workspaceState (one key per folder URI).
 * Global items live in globalState under pasteboard.global.
 */
export class PasteboardStorage {
	constructor(private readonly ctx: vscode.ExtensionContext) {}

	/** Build tab metadata for the current VS Code workspace. */
	getWorkspaceTabs(): WorkspaceTabInfo[] {
		const tabs: WorkspaceTabInfo[] = [{ id: 'global', label: 'GLOBAL' }];
		const folders = vscode.workspace.workspaceFolders ?? [];

		for (const folder of folders) {
			tabs.push({
				id: folder.uri.toString(),
				label: folder.name,
				uri: folder.uri.toString()
			});
		}

		if (folders.length === 0) {
			tabs.push({ id: 'local', label: 'Local', uri: undefined });
		}

		return tabs;
	}

	private workspaceKey(scope: TabScope): string {
		if (scope === 'global') {
			throw new Error('Use getGlobalItems/setGlobalItems for global scope');
		}
		return `${WORKSPACE_PREFIX}${scope}`;
	}

	getItems(scope: TabScope): PasteboardItem[] {
		if (scope === 'global') {
			return this.getGlobalItems();
		}
		return this.ctx.workspaceState.get<PasteboardItem[]>(this.workspaceKey(scope), []);
	}

	setItems(scope: TabScope, items: PasteboardItem[]): Thenable<void> {
		const pruned = this.pruneItems(items);
		if (scope === 'global') {
			return this.ctx.globalState.update(GLOBAL_KEY, pruned);
		}
		return this.ctx.workspaceState.update(this.workspaceKey(scope), pruned);
	}

	getGlobalItems(): PasteboardItem[] {
		return this.ctx.globalState.get<PasteboardItem[]>(GLOBAL_KEY, []);
	}

	/**
	 * Remove oldest non-pinned items when count exceeds pasteboard.maxItems.
	 */
	pruneItems(items: PasteboardItem[]): PasteboardItem[] {
		const maxItems = vscode.workspace
			.getConfiguration('pasteboard')
			.get<number>('maxItems', 200);

		if (items.length <= maxItems) {
			return items;
		}

		const pinned = items.filter(i => i.pinned);
		const unpinned = items
			.filter(i => !i.pinned)
			.sort((a, b) => a.updatedAt - b.updatedAt);

		const slotsForUnpinned = Math.max(0, maxItems - pinned.length);
		const keptUnpinned = unpinned.slice(unpinned.length - slotsForUnpinned);

		return [...pinned, ...keptUnpinned].sort((a, b) => b.updatedAt - a.updatedAt);
	}

	/** Migrate legacy single-text and array keys from older notepad extensions. */
	async migrateLegacyData(): Promise<void> {
		// Legacy plain-text workspace notepad
		const legacyText = this.ctx.workspaceState.get<string>(LEGACY_WORKSPACE_KEY);
		if (legacyText && legacyText.trim()) {
			const scope = this.defaultWorkspaceScope();
			const existing = this.getItems(scope);
			if (existing.length === 0) {
				const now = Date.now();
				await this.setItems(scope, [
					{
						id: generateId(),
						title: 'Migrated note',
						content: legacyText,
						createdAt: now,
						updatedAt: now,
						pinned: false
					}
				]);
			}
			await this.ctx.workspaceState.update(LEGACY_WORKSPACE_KEY, undefined);
		}

		// Legacy items array
		const legacyItems = this.ctx.workspaceState.get<PasteboardItem[]>(LEGACY_ITEMS_KEY);
		if (legacyItems && legacyItems.length > 0) {
			const scope = this.defaultWorkspaceScope();
			const existing = this.getItems(scope);
			if (existing.length === 0) {
				await this.setItems(scope, legacyItems);
			}
			await this.ctx.workspaceState.update(LEGACY_ITEMS_KEY, undefined);
		}
	}

	defaultWorkspaceScope(): TabScope {
		const folders = vscode.workspace.workspaceFolders;
		if (folders && folders.length > 0) {
			return folders[0].uri.toString();
		}
		return 'local';
	}
}

export function generateId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

export function createItem(title: string, content: string): PasteboardItem {
	const now = Date.now();
	return {
		id: generateId(),
		title: title.trim() || 'Untitled',
		content,
		createdAt: now,
		updatedAt: now,
		pinned: false
	};
}
