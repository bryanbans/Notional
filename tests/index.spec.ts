jest.mock("obsidian");
jest.mock("../service/notion");

import { initializeNotionPage } from "../service/index";
import notion from "../service/notion";

import NObsidian from "main";
import { TFile, App, PluginManifest } from "obsidian";

describe("initializeNotionPage", () => {
	let pluginMock: NObsidian;
	let fileMock: TFile;

	beforeEach(() => {
		jest.clearAllMocks();
		pluginMock = new NObsidian(new App(), {} as PluginManifest);
		fileMock = new TFile();
		fileMock.basename = "Some note";
	});

	it("does not create a Notion page when the note already has a notionPageId", async () => {
		// The default getContent mock returns a note that already has
		// notionPageId "12345", so no new page should be created.
		const result = await initializeNotionPage(pluginMock, fileMock);

		expect(pluginMock.getContent).toHaveBeenCalledWith(fileMock);
		expect(notion.createEmptyPage).not.toHaveBeenCalled();
		expect(result.notionPageId).toBe("12345");
	});

	it("creates a Notion page and writes back front matter when notionPageId is missing", async () => {
		(pluginMock.getContent as jest.Mock).mockResolvedValueOnce({
			__content: "Body without front matter.",
		});
		(notion.createEmptyPage as jest.Mock).mockResolvedValueOnce({
			data: {
				id: "new-page-id",
				url: "https://www.notion.so/new-page-id",
			},
			error: null,
		});

		const result = await initializeNotionPage(pluginMock, fileMock);

		expect(notion.createEmptyPage).toHaveBeenCalledWith(
			pluginMock.settings,
			fileMock.basename
		);
		expect(result.notionPageId).toBe("new-page-id");
		expect(pluginMock.updateMarkdownFile).toHaveBeenCalled();
	});
});
