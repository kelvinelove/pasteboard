import * as vscode from 'vscode';
import { PANEL_VIEW_TYPE, PasteboardProvider } from './pasteboardProvider';
import { PasteboardStorage } from './storage';

/** Priority for Status Bar placement — higher values sit closer to the right edge. */
const STATUS_BAR_PRIORITY = 1000;

/**
 * Extension entrypoint — registers the Status Bar trigger, sidebar webview,
 * optional panel, commands, and storage migration.
 */
export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
	const storage = new PasteboardStorage(ctx);
	await storage.migrateLegacyData();

	const provider = new PasteboardProvider(ctx, storage);

	// Status Bar trigger (right-aligned, near notifications area).
	const statusBarItem = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Right,
		STATUS_BAR_PRIORITY
	);
	statusBarItem.text = '$(clipboard) Pasteboard';
	statusBarItem.tooltip = 'Toggle Pasteboard sidebar';
	statusBarItem.command = 'pasteboard.toggle-sidebar';
	statusBarItem.show();

	ctx.subscriptions.push(
		statusBarItem,

		vscode.workspace.onDidChangeWorkspaceFolders(() => {
			provider.refreshTabs();
		}),

		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('pasteboard')) {
				provider.broadcastSettings();
			}
		}),

		vscode.window.registerWebviewViewProvider('pasteboard.view', provider, {
			webviewOptions: {
				retainContextWhenHidden: true
			}
		}),

		vscode.window.registerWebviewPanelSerializer(PANEL_VIEW_TYPE, {
			async deserializeWebviewPanel(panel: vscode.WebviewPanel) {
				provider.deserializePanel(panel);
			}
		}),

		vscode.commands.registerCommand('pasteboard.toggle-sidebar', async () => {
			await provider.toggleSidebar();
		}),

		vscode.commands.registerCommand('pasteboard.open', async () => {
			await provider.focusSidebarView();
		}),

		vscode.commands.registerCommand('pasteboard.toggle-panel-position', () => {
			provider.togglePanelPosition();
		}),

		vscode.commands.registerCommand('pasteboard.new-item', async () => {
			await provider.focusSidebarView();
			await provider.newItem();
		}),

		vscode.commands.registerCommand('pasteboard.save-item', async () => {
			await provider.saveItem();
		}),

		vscode.commands.registerCommand('pasteboard.delete-item', async () => {
			await provider.deleteItem();
		}),

		vscode.commands.registerCommand('pasteboard.open-global', async () => {
			await provider.focusSidebarView();
			provider.switchToGlobalTab();
		})
	);

	const openOnStartup = vscode.workspace
		.getConfiguration('pasteboard')
		.get<boolean>('openPanelOnStartup', false);
	if (openOnStartup) {
		provider.openPanel();
	}
}

export function deactivate(): void {
	// Disposables are registered on the extension context.
}
