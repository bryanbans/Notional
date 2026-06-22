/*
    Originally created by EasyChris (2022)
    Modified by Quan Phan (2023)

    This file is part of Notional and is licensed under the GNU General Public License v3.0.
    Modifications by the Notional maintainers are tracked in the project's Git history.

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

import {
	App,
	Notice,
	ObsidianProtocolData,
	Plugin,
	PluginManifest,
	TFile,
	TFolder,
	debounce,
	normalizePath,
} from "obsidian";
import {
	PluginSettings,
	MarkdownWithFrontMatter,
	NotionOAuthTokenResponse,
	ServiceResult,
	BulkUploadFileResult,
} from "service/types";
import {
	buildNotionOAuthUrl,
	completeNotionOAuth,
	generateOAuthState,
	hasNotionCredentials,
	hasNotionToken,
	isMatchingOAuthState,
} from "./service/oauth";
import { NObsidianSettingTab } from "settingTab";
import {
	NoticeMessageConfig,
	parseFrontMatter,
} from "service/utils";
import {
	pullFileFromNotion,
	runWithConcurrency,
	syncFile,
	uploadFile,
} from "service";
import { SyncView, VIEW_TYPE_SYNC } from "./view";

// Define your default settings
const DEFAULT_SETTINGS: PluginSettings = {
	notionAPIToken: "",
	notionOAuthClientId: "",
	notionOAuthClientSecret: "",
	notionOAuthRedirectUri: "https://bryanbans.github.io/Notional/oauth-callback.html",
	notionOAuthTokenExchangeUrl: "",
	notionOAuthAccessToken: "",
	notionOAuthWorkspaceId: "",
	notionOAuthWorkspaceName: "",
	notionOAuthRefreshToken: "",
	databaseID: "",
	notionParentPageUrl: "",
	bannerUrl: "",
	notionWorkspaceID: "",
	allowTags: false,
	autoSync: false,
	autoSyncIntervalMinutes: 5,
};

const BULK_UPLOAD_CONCURRENCY = 3;

// obsidian://notional-oauth?code=… — the static redirect page bounces the
// Notion callback here so the connect flow stays inside Obsidian.
const OAUTH_PROTOCOL_ACTION = "notional-oauth";

export default class NObsidian extends Plugin {
	settings: PluginSettings;
	message: { [key: string]: string };

	// Auto-sync bookkeeping.
	private suppressModify: Map<string, number> = new Map();
	private conflictNotified: Set<string> = new Set();
	private autoSyncDebouncers: Map<string, () => void> = new Map();
	private lastAutoPoll = 0;

	// In-flight OAuth: the CSRF state lives only in memory for the duration of
	// a single connect, never on disk.
	private pendingOAuthState: string | null = null;
	// Set by the settings tab so a callback that lands while it is open can
	// re-render the connection status.
	oauthRefresh: (() => void) | null = null;

	constructor(app: App, manifest: PluginManifest) {
		super(app, manifest);
		this.settings = DEFAULT_SETTINGS;
		this.message = NoticeMessageConfig("en");
	}

	async onload() {
		// Retrieve settings from settings tab
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			((await this.loadData()) as Partial<PluginSettings>)
		);

		// Register the sync side panel, ribbon icon, and opener command.
		this.registerView(
			VIEW_TYPE_SYNC,
			(leaf) => new SyncView(leaf, this)
		);
		this.addRibbonIcon("sync", "Open Notional sync panel", () => {
			void this.activateSyncView();
		});

		// Add commands to vault
		this.addCustomCommands();

		// Wire up optional automatic background sync.
		this.registerAutoSync();

		// Add settings tab to plugin (before optional wiring, so a failure in
		// later registration can never leave the settings pane blank).
		this.addSettingTab(new NObsidianSettingTab(this.app, this));

		// Capture the OAuth redirect (obsidian://notional-oauth?code=…) so the
		// user never has to copy a code back into Obsidian by hand.
		try {
			this.registerObsidianProtocolHandler(
				OAUTH_PROTOCOL_ACTION,
				(params) => {
					void this.handleOAuthCallback(params);
				}
			);
		} catch (error) {
			console.error("Notional: could not register OAuth protocol handler", error);
		}
	}

	/**
	 * Begins the OAuth flow: generates a CSRF state, remembers it in memory for
	 * the callback, and opens Notion's authorization page.
	 */
	startNotionOAuth(): ServiceResult<string> {
		const { notionOAuthClientId, notionOAuthRedirectUri } = this.settings;
		if (!notionOAuthClientId || !notionOAuthRedirectUri) {
			return {
				data: "",
				error: Error(
					"Set the OAuth client ID and redirect URI under Advanced first."
				),
			};
		}

		const state = generateOAuthState();
		this.pendingOAuthState = state;

		const url = buildNotionOAuthUrl({
			clientId: notionOAuthClientId,
			redirectUri: notionOAuthRedirectUri,
			state,
		});
		window.open(url, "_blank", "noopener,noreferrer");
		return { data: url, error: null };
	}

	/**
	 * Completes OAuth from a pasted callback URL/code. Used as a manual fallback
	 * when the protocol handler does not fire (e.g. the redirect opened a
	 * different vault).
	 */
	async finishNotionOAuthFromInput(
		input: string
	): Promise<ServiceResult<NotionOAuthTokenResponse>> {
		return this.completeOAuth(input);
	}

	private async handleOAuthCallback(
		params: ObsidianProtocolData
	): Promise<void> {
		if (params.error) {
			new Notice(`Notion authorization was declined: ${params.error}`);
			return;
		}

		// Claim the in-flight request up front. The redirect can fire the
		// handler more than once; since Notion consumes the code on first use, a
		// duplicate would otherwise attempt a second exchange and surface a
		// spurious "code revoked" error after we have already connected.
		const pendingState = this.pendingOAuthState;
		this.pendingOAuthState = null;
		if (!pendingState) {
			return;
		}
		if (!isMatchingOAuthState(pendingState, params.state)) {
			new Notice(
				"The Notion callback did not match the pending request. Please connect again."
			);
			return;
		}
		if (!params.code) {
			new Notice("The Notion callback did not include an authorization code.");
			return;
		}

		await this.completeOAuth(params.code);
	}

	private async completeOAuth(
		codeOrCallbackUrl: string
	): Promise<ServiceResult<NotionOAuthTokenResponse>> {
		const result = await completeNotionOAuth(
			this.settings,
			codeOrCallbackUrl
		);
		if (result.error) {
			new Notice(`Notion connection failed: ${result.error.message}`);
			return result;
		}

		const data = result.data;
		this.settings.notionOAuthAccessToken = data.access_token;
		this.settings.notionOAuthRefreshToken = data.refresh_token || "";
		this.settings.notionOAuthWorkspaceId = data.workspace_id || "";
		this.settings.notionOAuthWorkspaceName = data.workspace_name || "";
		this.pendingOAuthState = null;
		await this.saveSettings();

		const workspace = data.workspace_name;
		new Notice(
			workspace
				? `Connected to Notion workspace “${workspace}”.`
				: "Connected to Notion."
		);
		this.oauthRefresh?.();
		return result;
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	addCustomCommands() {
		this.addCommand({
			id: "share-to-notion",
			name: "Upload current note to Notion",
			editorCallback: async () => {
				void this.uploadCurrentNote();
			},
		});

		this.addCommand({
			id: "bulk-share-to-notion",
			name: "Upload current folder to Notion",
			callback: async () => {
				void this.uploadCurrentFolder();
			},
		});

		this.addCommand({
			id: "pull-current-note-from-notion",
			name: "Pull current note from Notion",
			editorCallback: async () => {
				void this.pullCurrentNote();
			},
		});

		this.addCommand({
			id: "sync-current-note-with-notion",
			name: "Sync current note with Notion",
			editorCallback: async () => {
				void this.syncCurrentNote();
			},
		});

		this.addCommand({
			id: "open-sync-panel",
			name: "Open sync panel",
			callback: () => {
				void this.activateSyncView();
			},
		});
	}

	async activateSyncView() {
		const { workspace } = this.app;

		let leaf = workspace.getLeavesOfType(VIEW_TYPE_SYNC)[0];
		if (!leaf) {
			const rightLeaf = workspace.getRightLeaf(false);
			if (!rightLeaf) return;
			leaf = rightLeaf;
			await leaf.setViewState({ type: VIEW_TYPE_SYNC, active: true });
		}

		void workspace.revealLeaf(leaf);
	}

	async uploadCurrentNote() {
		if (!this.hasValidNotionCredentials()) {
			new Notice(this.message["config-settings"]);
			return;
		}

		const nowFile = this.app.workspace.getActiveFile();
		if (!nowFile) {
			new Notice(this.message["open-file"]);
			return null;
		}

		void this.uploadFile(nowFile);
	}

	async uploadCurrentFolder() {
		if (!this.hasValidNotionCredentials()) {
			new Notice(this.message["config-settings"]);
			return;
		}

		const nowFile = this.app.workspace.getActiveFile();
		if (!nowFile) {
			new Notice(this.message["open-file"]);
			return;
		}

		const markdownFiles = this.collectUploadScope(nowFile);
		const results = await runWithConcurrency(
			markdownFiles,
			BULK_UPLOAD_CONCURRENCY,
			async (file): Promise<BulkUploadFileResult> => {
				try {
					const uploadResult = await this.uploadFile(file);
					return {
						fileName: file.basename,
						error: uploadResult.error,
					};
				} catch (error) {
					const uploadError =
						error instanceof Error ? error : Error(String(error));
					this.displayResult(
						{ data: null, error: uploadError },
						file.basename
					);
					return { fileName: file.basename, error: uploadError };
				}
			}
		);
		const failedUploads = results.filter((result) => result.error);

		if (failedUploads.length > 0) {
			const succeededUploads = results.length - failedUploads.length;
			new Notice(
				`Folder sync finished: ${succeededUploads}/${results.length} notes uploaded. ${failedUploads.length} failed.`,
				5000
			);
			return;
		}

		new Notice(this.message["all-sync-success"]);
	}

	getLinkedMarkdownFile(linkPath: string, sourcePath: string): TFile | null {
		return this.app.metadataCache.getFirstLinkpathDest(
			linkPath,
			sourcePath
		);
	}

	private collectUploadScope(file: TFile): TFile[] {
		const folder = file.parent;
		if (!folder || folder.isRoot()) return [file];

		return this.collectFolderNotes(folder);
	}

	private collectFolderNotes(folder: TFolder | null): TFile[] {
		if (!folder) return [];

		const markdownFiles: TFile[] = [];
		for (const child of folder.children) {
			if (child instanceof TFile && child.extension === "md") {
				markdownFiles.push(child);
			} else if (child instanceof TFolder) {
				markdownFiles.push(...this.collectFolderNotes(child));
			}
		}

		return markdownFiles;
	}

	async pullCurrentNote() {
		if (!this.hasValidNotionToken()) {
			new Notice(this.message["config-settings"]);
			return;
		}

		const nowFile = this.app.workspace.getActiveFile();
		if (!nowFile) {
			new Notice(this.message["open-file"]);
			return null;
		}

		const pullResult = await pullFileFromNotion(this, nowFile);
		this.displayResult(pullResult, nowFile.basename);
	}

	async syncCurrentNote() {
		if (!this.hasValidNotionToken()) {
			new Notice(this.message["config-settings"]);
			return;
		}

		const nowFile = this.app.workspace.getActiveFile();
		if (!nowFile) {
			new Notice(this.message["open-file"]);
			return null;
		}

		const syncResult = await syncFile(this, nowFile);
		this.displayResult(syncResult, nowFile.basename);
	}

	hasValidNotionCredentials() {
		return hasNotionCredentials(this.settings);
	}

	hasValidNotionToken() {
		return hasNotionToken(this.settings);
	}

	async uploadFile(file: TFile): Promise<ServiceResult> {
		const uploadResult = await uploadFile(this, file);
		this.displayResult(uploadResult, file.basename);
		return uploadResult;
	}

	async getContent(file: TFile): Promise<MarkdownWithFrontMatter> {
		const content = await this.app.vault.read(file);
		const contentWithFrontMatter = parseFrontMatter(content);
		return contentWithFrontMatter;
	}

	async createEmptyMarkdownFile(pageName: string): Promise<TFile> {
		const newFilePath = normalizePath(`${pageName}.md`);
		const newFile = await this.app.vault.create(newFilePath, "");
		return newFile;
	}

	async updateMarkdownFile(file: TFile, newContent: string): Promise<void> {
		// Mark this write so the auto-sync modify handler ignores our own edit.
		this.suppressModify.set(file.path, Date.now());
		await file.vault.modify(file, newContent);
	}

	private registerAutoSync() {
		const AUTO_SYNC_DEBOUNCE_MS = 3000;
		const SUPPRESS_WINDOW_MS = 2000;

		// Push a linked note shortly after the user stops editing it.
		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (!(file instanceof TFile)) return;
				if (!this.settings.autoSync) return;
				if (file.extension !== "md") return;
				if (!this.hasValidNotionToken()) return;

				const suppressedAt = this.suppressModify.get(file.path);
				if (
					suppressedAt &&
					Date.now() - suppressedAt < SUPPRESS_WINDOW_MS
				) {
					return;
				}

				let debounced = this.autoSyncDebouncers.get(file.path);
				if (!debounced) {
					debounced = debounce(
						() => {
							void this.autoSyncFile(file);
						},
						AUTO_SYNC_DEBOUNCE_MS,
						true
					);
					this.autoSyncDebouncers.set(file.path, debounced);
				}
				debounced();
			})
		);

		// Periodically pull the open note. A 60s ticker checks against the
		// configured interval so changing the interval needs no reload.
		this.registerInterval(
			window.setInterval(() => {
				if (!this.settings.autoSync) return;
				if (!this.hasValidNotionToken()) return;

				const intervalMs =
					Math.max(1, this.settings.autoSyncIntervalMinutes) * 60000;
				if (Date.now() - this.lastAutoPoll < intervalMs) return;

				this.lastAutoPoll = Date.now();
				void this.pollOpenNote();
			}, 60000)
		);
	}

	private async autoSyncFile(file: TFile) {
		// Only manage notes already linked to Notion; never auto-create pages.
		const contentWithFrontMatter = await this.getContent(file);
		if (!contentWithFrontMatter.notionPageId) return;

		const result = await syncFile(this, file);

		if (result.error) {
			if (/conflict/i.test(result.error.message)) {
				if (!this.conflictNotified.has(file.path)) {
					this.conflictNotified.add(file.path);
					new Notice(
						`Sync conflict in “${file.basename}” — resolve it in the Notional sync panel.`,
						8000
					);
				}
			}
			// Other background errors stay quiet to avoid noise.
		} else {
			this.conflictNotified.delete(file.path);
		}

		this.refreshSyncViews();
	}

	private async pollOpenNote() {
		const file = this.app.workspace.getActiveFile();
		if (!file || file.extension !== "md") return;
		await this.autoSyncFile(file);
	}

	private refreshSyncViews() {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_SYNC)) {
			const view = leaf.view;
			if (view instanceof SyncView) void view.refreshNow();
		}
	}

	displayResult(uploadResult: ServiceResult, pageName: string) {
		if (uploadResult.error) {
			const errorMessage = uploadResult.error.message;
			new Notice(`${errorMessage}${pageName}`, 5000);
			return;
		}

		new Notice(`${this.message["sync-success"]}${pageName}`);
	}
}
