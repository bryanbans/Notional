jest.mock("obsidian");
jest.mock("../service/notion");

import { initializeNotionPage, runWithConcurrency } from "../service/index";
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

	it("shares in-flight initialization for the same file", async () => {
		(pluginMock.getContent as jest.Mock).mockResolvedValue({
			__content: "Body without front matter.",
		});
		(notion.createEmptyPage as jest.Mock).mockResolvedValue({
			data: {
				id: "shared-page-id",
				url: "https://www.notion.so/shared-page-id",
			},
			error: null,
		});

		const results = await Promise.all([
			initializeNotionPage(pluginMock, fileMock),
			initializeNotionPage(pluginMock, fileMock),
		]);

		expect(pluginMock.getContent).toHaveBeenCalledTimes(1);
		expect(notion.createEmptyPage).toHaveBeenCalledTimes(1);
		expect(pluginMock.updateMarkdownFile).toHaveBeenCalledTimes(1);
		expect(results[0].notionPageId).toBe("shared-page-id");
		expect(results[1].notionPageId).toBe("shared-page-id");
	});
});

describe("runWithConcurrency", () => {
	it("caps active workers and preserves result order", async () => {
		let activeWorkers = 0;
		let maxActiveWorkers = 0;

		const results = await runWithConcurrency(
			[1, 2, 3, 4, 5],
			2,
			async (item) => {
				activeWorkers += 1;
				maxActiveWorkers = Math.max(maxActiveWorkers, activeWorkers);
				await Promise.resolve();
				activeWorkers -= 1;
				return item * 2;
			}
		);

		expect(maxActiveWorkers).toBeLessThanOrEqual(2);
		expect(results).toEqual([2, 4, 6, 8, 10]);
	});

	it("rejects invalid concurrency values", async () => {
		await expect(
			runWithConcurrency([1], 0, async (item) => item)
		).rejects.toThrow("Concurrency must be a positive integer");
	});
});
