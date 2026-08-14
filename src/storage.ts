import * as vscode from 'vscode';
import { PasteboardItem, TabScope, WorkspaceTabInfo } from './types';

/** Keys used for persistence in Memento storage. */
const GLOBAL_KEY = 'pasteboard.global';
const WORKSPACE_PREFIX = 'pasteboard.workspace.';
const LEGACY_WORKSPACE_KEY = 'workspace-notepad';
const LEGACY_ITEMS_KEY = 'workspace-notepad.notes';
const FILE_NAME_SEGMENTS = ['.vscode', 'pasteboard.json'];

type StorageMode = 'state' | 'file';

/**
 * Manages reading/writing PasteboardItem arrays for global and per-folder scopes.
 * Workspace items live in workspaceState (one key per folder URI) by default, or in a
 * per-folder .vscode/pasteboard.json file when pasteboard.storageMode is "file".
 * Global items always live in globalState under pasteboard.global — GLOBAL is
 * cross-workspace by definition, so it has no single workspace folder to write a file into.
 */
export class PasteboardStorage {
	/** In-memory mirror of on-disk file storage, keyed by workspace-folder scope, so getItems() can stay synchronous. */
	private readonly fileCache = new Map<string, PasteboardItem[]>();

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

	private storageMode(): StorageMode {
		return vscode.workspace.getConfiguration('pasteboard').get<StorageMode>('storageMode', 'state');
	}

	private folderForScope(scope: TabScope): vscode.WorkspaceFolder | undefined {
		return vscode.workspace.workspaceFolders?.find(f => f.uri.toString() === scope);
	}

	/** True when `scope` should be read/written through the .vscode/pasteboard.json file rather than workspaceState. */
	private usesFile(scope: TabScope): boolean {
		return scope !== 'global' && this.storageMode() === 'file' && this.folderForScope(scope) !== undefined;
	}

	getItems(scope: TabScope): PasteboardItem[] {
		if (scope === 'global') {
			return this.getGlobalItems();
		}
		if (this.usesFile(scope)) {
			return this.fileCache.get(scope) ?? [];
		}
		return this.ctx.workspaceState.get<PasteboardItem[]>(this.workspaceKey(scope), []);
	}

	async setItems(scope: TabScope, items: PasteboardItem[]): Promise<void> {
		const pruned = this.pruneItems(items);
		if (items.length > pruned.length) {
			this.notifyPruned(scope, items.length - pruned.length);
		}
		if (scope === 'global') {
			await this.ctx.globalState.update(GLOBAL_KEY, pruned);
			return;
		}
		if (this.usesFile(scope)) {
			// Update the in-memory cache first so a synchronous getItems() right after this call sees the write immediately.
			this.fileCache.set(scope, pruned);
			await this.writeFile(scope, pruned);
			return;
		}
		await this.ctx.workspaceState.update(this.workspaceKey(scope), pruned);
	}

	getGlobalItems(): PasteboardItem[] {
		return this.ctx.globalState.get<PasteboardItem[]>(GLOBAL_KEY, []);
	}

	/**
	 * Read every workspace folder's pasteboard.json into the in-memory cache.
	 * Called on activation, on pasteboard.storageMode changes, and when the file
	 * changes on disk (e.g. edited by another IDE window) so reads stay in sync.
	 * No-op when storageMode is "state".
	 */
	async loadFileCache(): Promise<void> {
		if (this.storageMode() !== 'file') {
			return;
		}
		const folders = vscode.workspace.workspaceFolders ?? [];
		await Promise.all(
			folders.map(async folder => {
				const scope = folder.uri.toString();
				try {
					const raw = await vscode.workspace.fs.readFile(this.fileUri(folder));
					const parsed: unknown = JSON.parse(new TextDecoder().decode(raw));
					this.fileCache.set(scope, Array.isArray(parsed) ? (parsed as PasteboardItem[]) : []);
				} catch {
					// Missing, unreadable, or invalid JSON — treat as no items yet; a save will (re)create the file.
					this.fileCache.set(scope, []);
				}
			})
		);
	}

	private fileUri(folder: vscode.WorkspaceFolder): vscode.Uri {
		return vscode.Uri.joinPath(folder.uri, ...FILE_NAME_SEGMENTS);
	}

	private async writeFile(scope: TabScope, items: PasteboardItem[]): Promise<void> {
		const folder = this.folderForScope(scope);
		if (!folder) {
			return;
		}
		await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder.uri, '.vscode'));
		const encoded = new TextEncoder().encode(JSON.stringify(items, null, 2));
		await vscode.workspace.fs.writeFile(this.fileUri(folder), encoded);
	}

	/** Surface pruning instead of silently deleting old notes with no trace. */
	private notifyPruned(scope: TabScope, droppedCount: number): void {
		const maxItems = vscode.workspace.getConfiguration('pasteboard').get<number>('maxItems', 200);
		const label = this.getWorkspaceTabs().find(t => t.id === scope)?.label ?? scope;
		void vscode.window.showInformationMessage(
			`Pasteboard: Removed ${droppedCount} old, unpinned item${droppedCount === 1 ? '' : 's'} from "${label}" to stay within the ${maxItems}-item limit. Pin notes you want to keep.`
		);
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
		// Load file-backed items first so getItems() below reflects file storage if that mode is active.
		await this.loadFileCache();

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
