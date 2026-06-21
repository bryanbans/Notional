import { App, PluginManifest } from "obsidian";
import { PluginSettings } from "../service/types";
import { NoticeMessageConfig } from "../service/utils";

class NObsidian {
	settings: PluginSettings;
	message: { [key: string]: string };

	constructor(app: App, manifest: PluginManifest) {
		this.settings = {
			notionAPIToken: "",
			databaseID: "",
			notionParentPageUrl: "",
			bannerUrl: "",
			notionWorkspaceID: "",
			allowTags: false,
			autoSync: false,
			autoSyncIntervalMinutes: 5,
		};
		this.message = NoticeMessageConfig("en");
	}

	getContent = jest.fn().mockResolvedValue({
		tags: ["example", "test"],
		notionPageId: "12345",
		notionPageUrl: "https://www.notion.so/12345",
		__content:
			"This is a **markdown** document.\n\n- Point 1\n- Point 2\n\nEnd of document.",
	});

	createEmptyMarkdownFile = jest.fn().mockResolvedValue({
		basename: "New Document",
	});

	getLinkedMarkdownFile = jest.fn();

	updateMarkdownFile = jest.fn();
}

export default NObsidian;
