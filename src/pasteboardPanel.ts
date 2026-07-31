import * as vscode from 'vscode';

interface PasteboardPanelOptions {
	viewType: string;
	title: string;
	buildHtml: (webview: vscode.Webview) => string;
	onDidReceiveMessage: (message: unknown) => void;
	onDidDispose: () => void;
	extensionUri: vscode.Uri;
}

/**
 * Small wrapper around a VS Code WebviewPanel that offers a compact-width
 * fallback for the sidebar view when the user prefers a Beside panel.
 */
export class PasteboardPanel {
	public readonly panel: vscode.WebviewPanel;

	constructor(private readonly ctx: vscode.ExtensionContext, options: PasteboardPanelOptions) {
		this.panel = vscode.window.createWebviewPanel(
			options.viewType,
			options.title,
			vscode.ViewColumn.Beside,
			{
				enableScripts: true,
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

		this.panel.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				vscode.Uri.joinPath(this.ctx.extensionUri, 'assets'),
				vscode.Uri.joinPath(this.ctx.extensionUri, 'out')
			]
		};

		this.panel.webview.html = options.buildHtml(this.panel.webview);
		this.panel.webview.onDidReceiveMessage(options.onDidReceiveMessage);
		this.panel.onDidDispose(options.onDidDispose);
		this.panel.onDidChangeViewState(() => {
			if (this.panel.visible) {
				void this.applyCompactWidthHeuristic();
			}
		});
	}

	public reveal(): void {
		this.panel.reveal(vscode.ViewColumn.Beside, true);
		void this.applyCompactWidthHeuristic();
	}

	public dispose(): void {
		this.panel.dispose();
	}

	public get webview(): vscode.Webview {
		return this.panel.webview;
	}

	public get visible(): boolean {
		return this.panel.visible;
	}

	private async applyCompactWidthHeuristic(): Promise<void> {
		const preferredWidthPercent = vscode.workspace
			.getConfiguration('pasteboard')
			.get<number>('preferredWidthPercent', 28);

		const steps = Math.max(1, Math.min(6, Math.round((100 - preferredWidthPercent) / 10)));
		for (let i = 0; i < steps; i += 1) {
			await new Promise(resolve => setTimeout(resolve, 60));
			await vscode.commands.executeCommand('workbench.action.decreaseViewSize');
		}
	}
}
