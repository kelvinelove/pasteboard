import * as vscode from 'vscode';

interface PasteboardPanelOptions {
	viewType: string;
	title: string;
	onDidDispose: () => void;
	/** Fired on every visible/hidden transition (e.g. switching editor tabs away and back), not just disposal. */
	onDidChangeViewState?: () => void;
	extensionUri: vscode.Uri;
}

/**
 * Small wrapper around a VS Code WebviewPanel that offers a compact-width
 * fallback for the sidebar view when the user prefers a Beside panel.
 */
export class PasteboardPanel {
	public readonly panel: vscode.WebviewPanel;
	private readonly panelWebview: vscode.Webview;
	private disposed = false;
	private compactWidthAdjustmentStarted = false;

	constructor(private readonly ctx: vscode.ExtensionContext, options: PasteboardPanelOptions) {
		this.panel = vscode.window.createWebviewPanel(
			options.viewType,
			options.title,
			vscode.ViewColumn.Beside,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [
					vscode.Uri.joinPath(this.ctx.extensionUri, 'assets'),
					vscode.Uri.joinPath(this.ctx.extensionUri, 'out')
				]
			}
		);

		this.panel.iconPath = {
			light: vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'icons', 'light.svg'),
			dark: vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'icons', 'dark.svg')
		};
		// Keep the Webview reference while the panel is alive. VS Code may dispose
		// the panel before the provider's cleanup callback runs, so cleanup must not
		// retrieve panel.webview from a disposed panel.
		this.panelWebview = this.panel.webview;

		// Intentionally do NOT set webview.html or webview.onDidReceiveMessage here.
		// PasteboardProvider.attachWebview() is the single place that does both, for
		// both this panel and the sidebar WebviewView. A prior version set them here
		// too, which registered a second message listener on the same webview — every
		// panel message (including "toggle panel") was handled twice, which closed and
		// then immediately reopened the panel on a single click.
		this.panel.onDidDispose(() => {
			this.disposed = true;
			options.onDidDispose();
		});
		this.panel.onDidChangeViewState(() => {
			options.onDidChangeViewState?.();
		});
	}

	public reveal(): void {
		if (!this.disposed) {
			this.panel.reveal(vscode.ViewColumn.Beside, true);
		}
	}

	public dispose(): void {
		if (!this.disposed) {
			this.disposed = true;
			this.panel.dispose();
		}
	}

	public get webview(): vscode.Webview {
		return this.panelWebview;
	}

	public get visible(): boolean {
		return !this.disposed && this.panel.visible;
	}

	public get isDisposed(): boolean {
		return this.disposed;
	}

	public async applyCompactWidthHeuristic(currentWidth: number): Promise<void> {
		if (this.compactWidthAdjustmentStarted || !Number.isFinite(currentWidth) || currentWidth <= 0) {
			return;
		}
		this.compactWidthAdjustmentStarted = true;

		const preferredWidthPercent = vscode.workspace
			.getConfiguration('pasteboard')
			.get<number>('preferredWidthPercent', 25);

		// A fresh beside group starts at roughly half of the editor area. Each VS Code
		// width adjustment is 60 CSS px, so use the measured webview width to approach
		// the configured fraction of the full editor area on different display sizes.
		const widthToRemove = currentWidth * (1 - 2 * preferredWidthPercent / 100);
		const steps = Math.max(0, Math.min(32, Math.round(widthToRemove / 60)));
		for (let i = 0; i < steps; i += 1) {
			await new Promise(resolve => setTimeout(resolve, 80));
			await vscode.commands.executeCommand('workbench.action.decreaseViewWidth');
		}
	}
}
