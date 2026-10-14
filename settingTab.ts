/*
    Originally created by EasyChris (2022) in main.ts
    Extracted to settingTab.ts and modified by Quan Phan (2023)

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
	PluginSettingTab,
	Setting,
	SettingDefinitionItem,
} from "obsidian";
import NObsidian from "main";
import { PluginSettings, StringKeys, BooleanKeys } from "./service/types";
import notion from "./service/notion";
import { resolveNotionToken } from "./service/oauth";
import { extractNotionId, PUSH_ONLY } from "./service/utils";

export class NObsidianSettingTab extends PluginSettingTab {
	plugin: NObsidian;
	private oauthCallbackInput = "";

	constructor(app: App, plugin: NObsidian) {
		super(app, plugin);
		this.plugin = plugin;
	}

	// Return empty so Obsidian falls back to display() below, which renders our
	// custom UI reliably across Obsidian versions. (The declarative
	// getSettingDefinitions custom-render path did not invoke our renderer.)
	getSettingDefinitions(): SettingDefinitionItem[] {
		return [];
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		try {
			this.renderSettings(containerEl);
		} catch (error) {
			console.error("Notional settings render error", error);
			containerEl.createEl("p", {
				cls: "setting-item-description nob-status-bad",
				text: `Notional settings failed to render: ${
					error instanceof Error ? error.message : String(error)
				}`,
			});
		}
	}

	private renderSettings(containerEl: HTMLElement): void {
		this.renderConnectSection(containerEl);
		this.renderDatabaseSection(containerEl);
		if (!PUSH_ONLY) this.renderAutoSyncSection(containerEl);
		this.renderAdvancedSection(containerEl);
	}

	private renderAutoSyncSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Automatic sync").setHeading();

		this.createToggleSetting(containerEl, {
			name: "Automatic sync (experimental)",
			desc: "Push a linked note to Notion shortly after you edit it, and periodically pull the open note. Conflicts are never auto-resolved — they appear in the sync panel.",
			settingKey: "autoSync",
		});

		new Setting(containerEl)
			.setName("Poll interval (minutes)")
			.setDesc(
				"How often to check the open note for Notion-side changes."
			)
			.addText((text) =>
				text
					.setValue(
						String(this.plugin.settings.autoSyncIntervalMinutes)
					)
					.onChange(async (value) => {
						const parsed = Number.parseInt(value, 10);
						this.plugin.settings.autoSyncIntervalMinutes =
							Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
						await this.plugin.saveSettings();
					})
			);
	}

	private renderConnectSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("1. Connect to Notion").setHeading();

		const help = containerEl.createEl("p", {
			cls: "setting-item-description",
		});
		help.appendText("Create a connection at ");
		const link = help.createEl("a", {
			text: "notion.so/my-integrations",
			href: "https://www.notion.so/my-integrations",
		});
		link.setAttr("target", "_blank");
		link.setAttr("rel", "noopener");
		help.appendText(
			" (choose “Access token”), copy its secret below, then open the Notion page you want to use and share it with that connection (••• → Connections)."
		);

		const oauthStatus = containerEl.createEl("div", {
			cls: "setting-item-description nob-setup-status",
		});
		this.renderOAuthStatus(oauthStatus);

		// Re-render this tab when an OAuth callback completes while it is open.
		this.plugin.oauthRefresh = () => this.update();

		new Setting(containerEl)
			.setName("Connect with Notion")
			.setDesc(
				"Opens Notion to pick the pages to share, then returns to Obsidian automatically. Your client secret stays on this device — nothing is sent to any server but Notion."
			)
			.addButton((button) =>
				button
					.setButtonText("Connect with Notion")
					.setClass("mod-cta")
					.onClick(() => {
						if (!this.hasOAuthConfiguration()) {
							this.setStatus(
								oauthStatus,
								false,
								"Add the OAuth client ID and redirect URI under Advanced first."
							);
							return;
						}
						const result = this.plugin.startNotionOAuth();
						if (result.error) {
							this.setStatus(
								oauthStatus,
								false,
								result.error.message
							);
							return;
						}
						this.setStatus(
							oauthStatus,
							null,
							"Approve access in Notion — you'll be returned to Obsidian. If nothing happens, paste the callback URL below."
						);
					})
			);

		new Setting(containerEl)
			.setName("Finish manually (fallback)")
			.setDesc(
				"Only needed if Obsidian wasn't reopened automatically. Paste the redirected URL (or code) from your browser."
			)
			.addText((text) =>
				text
					.setPlaceholder("https://.../oauth-callback.html?code=… or code")
					.setValue(this.oauthCallbackInput)
					.onChange((value) => {
						this.oauthCallbackInput = value;
					})
			)
			.addButton((button) =>
				button.setButtonText("Finish OAuth").onClick(async () => {
					button.setDisabled(true);
					this.setStatus(oauthStatus, null, "Finishing OAuth…");
					const result = await this.plugin.finishNotionOAuthFromInput(
						this.oauthCallbackInput
					);
					button.setDisabled(false);

					if (result.error) {
						this.setStatus(oauthStatus, false, result.error.message);
						return;
					}

					this.oauthCallbackInput = "";
					this.setStatus(
						oauthStatus,
						true,
						this.oauthConnectedMessage()
					);
				})
			);

		this.createTextSetting(containerEl, {
			name: "Notion API token",
			desc: "Manual fallback: paste an internal integration secret or OAuth access token.",
			placeholder: "ntn_…",
			settingKey: "notionAPIToken",
			isPassword: true,
		});

		const status = containerEl.createEl("div", {
			cls: "setting-item-description nob-setup-status",
		});

		new Setting(containerEl)
			.setName("Test connection")
			.setDesc("Check that the token can reach Notion.")
			.addButton((button) =>
				button.setButtonText("Test").onClick(async () => {
					if (!resolveNotionToken(this.plugin.settings)) {
						this.setStatus(
							status,
							false,
							"Connect with Notion or enter a token first."
						);
						return;
					}
					button.setDisabled(true);
					this.setStatus(status, null, "Testing…");
					const result = await notion.validateToken(
						this.plugin.settings
					);
					button.setDisabled(false);
					if (result.error) {
						this.setStatus(
							status,
							false,
							"Could not connect. Double-check the token."
						);
						return;
					}
					const name = (result.data as { name?: string } | null)?.name;
					this.setStatus(
						status,
						true,
						`Connected${name ? ` as “${name}”` : ""}.`
					);
				})
			);
	}

	private renderOAuthStatus(el: HTMLElement): void {
		if (this.plugin.settings.notionOAuthWorkspaceName) {
			this.setStatus(el, true, this.oauthConnectedMessage());
			return;
		}

		if (this.hasOAuthConfiguration()) {
			this.setStatus(
				el,
				null,
				"Ready to connect. Click “Connect with Notion” to authorize selected pages."
			);
			return;
		}

		this.setStatus(
			el,
			null,
			"To use one-click connect, add the OAuth client ID under Advanced. Or paste a token below."
		);
	}

	private oauthConnectedMessage(): string {
		const workspace = this.plugin.settings.notionOAuthWorkspaceName;
		return workspace
			? `OAuth connected to ${workspace}.`
			: "OAuth connected.";
	}

	private hasOAuthConfiguration(): boolean {
		const { notionOAuthClientId, notionOAuthRedirectUri } =
			this.plugin.settings;

		// The token-exchange endpoint is optional: by default the PKCE flow
		// talks to Notion directly with no secret.
		return Boolean(notionOAuthClientId && notionOAuthRedirectUri);
	}

	private renderDatabaseSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("2. Choose where your notes go").setHeading();

		const status = containerEl.createEl("div", {
			cls: "setting-item-description nob-setup-status",
		});
		this.renderDatabaseStatus(status);

		this.createTextSetting(containerEl, {
			name: "Notion parent page link",
			desc: "Paste the link of a Notion page you've shared with your connection. Notional creates a database there to hold your notes.",
			placeholder: "https://www.notion.so/Your-Page-…",
			settingKey: "notionParentPageUrl",
			isPassword: false,
		});

		new Setting(containerEl)
			.setName("Create notes database")
			.setDesc(
				"Creates the database Notional uploads into and remembers it for you."
			)
			.addButton((button) =>
				button
					.setButtonText(
						this.plugin.settings.databaseID ? "Re-create" : "Create"
					)
					.setClass("mod-cta")
					.onClick(async () => {
						const pageId = extractNotionId(
							this.plugin.settings.notionParentPageUrl
						);
						if (!pageId) {
							this.setStatus(
								status,
								false,
								"Couldn't read a page ID from that link. Paste a full Notion page URL."
							);
							return;
						}
						button.setDisabled(true);
						this.setStatus(status, null, "Creating database…");
						const result = await notion.createDatabase(
							this.plugin.settings,
							pageId
						);
						button.setDisabled(false);
						if (result.error) {
							this.setStatus(
								status,
								false,
								"Could not create the database. Make sure the page is shared with your connection."
							);
							return;
						}
						this.plugin.settings.databaseID = (result.data as { id: string }).id;
						await this.plugin.saveSettings();
						this.update();
					})
			);
	}

	private renderDatabaseStatus(el: HTMLElement): void {
		const databaseID = this.plugin.settings.databaseID;
		if (!databaseID) {
			this.setStatus(
				el,
				null,
				"No database yet. Create one below, or set a Database ID manually under Advanced."
			);
			return;
		}

		el.empty();
		el.addClass("nob-status-ok");
		el.appendText("Notes database is set ✓  ");
		const link = el.createEl("a", {
			text: "Open in Notion ↗",
			href: `https://www.notion.so/${databaseID.replace(/-/g, "")}`,
		});
		link.setAttr("target", "_blank");
		link.setAttr("rel", "noopener");
	}

	private renderAdvancedSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Advanced").setHeading();

		this.createTextSetting(containerEl, {
			name: "Database ID",
			desc: "Set manually to use an existing Notion database instead of creating one above.",
			placeholder: "Enter your Database ID",
			settingKey: "databaseID",
			isPassword: false,
		});

		this.createTextSetting(containerEl, {
			name: "Banner URL (optional)",
			desc: "Page banner URL. If you want to show a banner, please enter the URL.",
			placeholder: "Enter banner pic URL",
			settingKey: "bannerUrl",
			isPassword: false,
		});

		this.createTextSetting(containerEl, {
			name: "Notion Workspace ID (optional)",
			desc: "Used to format share links as https://<workspace>.notion.site/",
			placeholder: "Enter Notion ID",
			settingKey: "notionWorkspaceID",
			isPassword: false,
		});

		new Setting(containerEl).setName("OAuth").setHeading();

		this.createTextSetting(containerEl, {
			name: "OAuth client ID",
			desc: "Client ID of your Notion OAuth integration (notion.so/profile/integrations → New connection → OAuth).",
			placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
			settingKey: "notionOAuthClientId",
			isPassword: false,
		});

		this.createTextSetting(containerEl, {
			name: "OAuth client secret",
			desc: "Secret from the same integration. Stored only on this device and sent only to Notion to complete sign-in.",
			placeholder: "secret_…",
			settingKey: "notionOAuthClientSecret",
			isPassword: true,
		});

		this.createTextSetting(containerEl, {
			name: "OAuth redirect URI",
			desc: "Redirect URI registered on the integration. The hosted page bounces the callback back into Obsidian. Defaults to the Notional redirect page.",
			placeholder: "https://bryanbans.github.io/Notional/oauth-callback.html",
			settingKey: "notionOAuthRedirectUri",
			isPassword: false,
		});

		this.createTextSetting(containerEl, {
			name: "OAuth token exchange endpoint (optional)",
			desc: "Leave blank to exchange directly with Notion using your client secret (recommended). Only set this to route the exchange through a hosted endpoint that holds the secret instead.",
			placeholder: "https://example.com/api/notion/oauth/token",
			settingKey: "notionOAuthTokenExchangeUrl",
			isPassword: false,
		});

		this.createToggleSetting(containerEl, {
			name: "Convert tags (optional)",
			desc: "Transfer Obsidian tags to the Notion table. Requires a 'Tags' column in Notion.",
			settingKey: "allowTags",
		});
	}

	private setStatus(
		el: HTMLElement,
		ok: boolean | null,
		text: string
	): void {
		el.setText(text);
		el.removeClass("nob-status-ok", "nob-status-bad");
		if (ok === true) el.addClass("nob-status-ok");
		else if (ok === false) el.addClass("nob-status-bad");
	}

	createTextSetting(
		containerEl: HTMLElement,
		options: {
			name: string;
			desc: string;
			placeholder: string;
			settingKey: StringKeys<PluginSettings>;
			isPassword: boolean;
		}
	) {
		new Setting(containerEl)
			.setName(options.name)
			.setDesc(options.desc)
			.addText((text) => {
				text.setPlaceholder(options.placeholder)
					.setValue(this.plugin.settings[options.settingKey])
					.onChange(async (value) => {
						this.plugin.settings[options.settingKey] = value;
						await this.plugin.saveSettings();
					});
				if (options.isPassword) {
					text.inputEl.type = "password";
				}
			});
	}

	createToggleSetting(
		containerEl: HTMLElement,
		options: {
			name: string;
			desc: string;
			settingKey: BooleanKeys<PluginSettings>;
		}
	) {
		new Setting(containerEl)
			.setName(options.name)
			.setDesc(options.desc)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings[options.settingKey])
					.onChange(async (value) => {
						this.plugin.settings[options.settingKey] = value;
						await this.plugin.saveSettings();
					});
			});
	}
}
