import * as vscode from 'vscode';
import { PANEL_VIEW_TYPE, PasteboardProvider } from './pasteboardProvider';
import { PasteboardStorage } from './storage';

/** Priority for Status Bar placement — higher values sit closer to the right edge. */
const STATUS_BAR_PRIORITY = 1000;

type Placement = 'sidebar-right' | 'sidebar-left' | 'panel-beside';

/**
 * Extension entrypoint — registers the Status Bar trigger, view provider,
 * fallback WebviewPanel, commands, and storage migration.
 */
export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
	const storage = new PasteboardStorage(ctx);
	await storage.migrateLegacyData();

	const provider = new PasteboardProvider(ctx, storage);

	// Create the right-aligned Status Bar item the user will see in the bottom-right corner.
	const statusBarItem = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Right,
		STATUS_BAR_PRIORITY
	);
	statusBarItem.text = '$(clipboard) Pasteboard';
	statusBarItem.tooltip = 'Toggle Pasteboard';
	statusBarItem.command = 'pasteboard.toggleFromStatusBar';
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

		vscode.commands.registerCommand('pasteboard.toggleFromStatusBar', async () => {
			await provider.toggleSidebar();
		}),

		vscode.commands.registerCommand('pasteboard.toggle-sidebar', async () => {
			await provider.toggleSidebar();
		}),

		vscode.commands.registerCommand('pasteboard.togglePanel', async () => {
			provider.togglePanelPosition();
		}),

		vscode.commands.registerCommand('pasteboard.open', async () => {
			await provider.openPrimaryView();
		}),

		vscode.commands.registerCommand('pasteboard.toggle-panel-position', () => {
			provider.togglePanelPosition();
		}),

		vscode.commands.registerCommand('pasteboard.new-item', async () => {
			await provider.openPrimaryView();
			await provider.newItem();
		}),

		vscode.commands.registerCommand('pasteboard.save-item', async () => {
			await provider.saveItem();
		}),

		vscode.commands.registerCommand('pasteboard.delete-item', async () => {
			await provider.deleteItem();
		}),

		vscode.commands.registerCommand('pasteboard.open-global', async () => {
			await provider.openPrimaryView();
			provider.switchToGlobalTab();
		}),

		vscode.commands.registerCommand('pasteboard.openGlobalTab', async () => {
			await provider.openPrimaryView();
			provider.switchToGlobalTab();
		}),

		vscode.commands.registerCommand('pasteboard.setDefaultPlacement', async () => {
			interface PlacementQuickPickItem {
				label: string;
				description: string;
				value: Placement;
			}
			const choice = await vscode.window.showQuickPick<PlacementQuickPickItem>([
				{ label: 'Right sidebar', description: 'Prefer the compact sidebar view on the right', value: 'sidebar-right' },
				{ label: 'Left sidebar', description: 'Use the sidebar view on the left', value: 'sidebar-left' },
				{ label: 'Beside editor', description: 'Open a compact panel beside the editor', value: 'panel-beside' }
			], {
				placeHolder: 'Choose Pasteboard default placement'
			});
			if (choice) {
				await ctx.globalState.update('pasteboard.lastPlacement', choice.value);
				void vscode.window.showInformationMessage(`Pasteboard will prefer ${choice.value === 'panel-beside' ? 'a beside panel' : 'the sidebar'} on next open.`);
			}
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
