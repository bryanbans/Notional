jest.mock("obsidian");
jest.mock("../service/notion");

import {
	convertObsidianLinks,
	getSyncStatus,
	initializeNotionPage,
	pullFileFromNotion,
	runWithConcurrency,
	uploadLocalImages,
	MAX_IMAGE_UPLOAD_BYTES,
} from "../service/index";
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

describe("convertObsidianLinks", () => {
	let pluginMock: NObsidian;
	let fileMock: TFile;

	beforeEach(() => {
		jest.clearAllMocks();
		pluginMock = new NObsidian(new App(), {} as PluginManifest);
		fileMock = new TFile();
		fileMock.basename = "Linked note";
		fileMock.path = "Linked note.md";
		fileMock.extension = "md";
		(pluginMock.getLinkedMarkdownFile as jest.Mock).mockReturnValue(
			fileMock
		);
	});

	it("keeps only the display text for notes not yet pushed", async () => {
		(pluginMock.getContent as jest.Mock).mockResolvedValueOnce({
			__content: "",
		});

		const result = await convertObsidianLinks(
			pluginMock,
			fileMock,
			"See [[Private note|that note]]."
		);

		expect(result).toBe("See that note.");
		expect(notion.createEmptyPage).not.toHaveBeenCalled();
		expect(pluginMock.updateMarkdownFile).not.toHaveBeenCalled();
	});

	it("never creates vault files for missing link targets", async () => {
		(pluginMock.getLinkedMarkdownFile as jest.Mock).mockReturnValue(null);

		const result = await convertObsidianLinks(
			pluginMock,
			fileMock,
			"See [[Missing note]] and ![[Embedded note]]."
		);

		expect(result).toBe("See Missing note and Embedded note.");
		expect(pluginMock.createEmptyMarkdownFile).not.toHaveBeenCalled();
		expect(notion.createEmptyPage).not.toHaveBeenCalled();
	});

	it("converts wiki-links into Notion page mention markers", async () => {
		const result = await convertObsidianLinks(
			pluginMock,
			fileMock,
			"See [[Linked note|the linked note]]."
		);

		expect(result).toBe(
			"See [the linked note](notional://notion-page/12345)."
		);
		expect(pluginMock.getLinkedMarkdownFile).toHaveBeenCalledWith(
			"Linked note",
			fileMock.path
		);
		expect(pluginMock.createEmptyMarkdownFile).not.toHaveBeenCalled();
	});
});

describe("uploadLocalImages", () => {
	let pluginMock: NObsidian;
	let noteMock: TFile;

	const makeFile = (name: string, size = 100): TFile => {
		const file = new TFile();
		file.name = name;
		file.path = `assets/${name}`;
		file.extension = name.split(".").pop() ?? "";
		file.stat = { ctime: 0, mtime: 0, size };
		return file;
	};

	beforeEach(() => {
		jest.clearAllMocks();
		pluginMock = new NObsidian(new App(), {} as PluginManifest);
		noteMock = new TFile();
		noteMock.path = "Note.md";
		(notion.uploadImage as jest.Mock).mockResolvedValue({
			data: "upload-1",
			error: null,
		});
	});

	it("uploads embedded and relative images once each", async () => {
		const image = makeFile("diagram.png");
		(pluginMock.getLinkedMarkdownFile as jest.Mock).mockReturnValue(image);

		const result = await uploadLocalImages(
			pluginMock,
			noteMock,
			"![[diagram.png|300]]\n![Diagram](<assets/diagram.png>)"
		);

		expect(result.markdown).toBe(
			"![](https://notional.invalid/file-upload/upload-1.png)\n" +
				"![Diagram](https://notional.invalid/file-upload/upload-1.png)"
		);
		expect(result.skipped).toEqual([]);
		expect(notion.uploadImage).toHaveBeenCalledTimes(1);
		expect(notion.uploadImage).toHaveBeenCalledWith(
			pluginMock.settings,
			"diagram.png",
			"image/png",
			expect.any(ArrayBuffer)
		);
		expect(pluginMock.getLinkedMarkdownFile).toHaveBeenCalledWith(
			"assets/diagram.png",
			"Note.md"
		);
	});

	it("leaves remote images and note embeds untouched", async () => {
		const note = makeFile("Other.md");
		(pluginMock.getLinkedMarkdownFile as jest.Mock).mockReturnValue(note);
		const markdown = "![x](https://example.com/a.png) ![[Other]]";

		const result = await uploadLocalImages(pluginMock, noteMock, markdown);

		expect(result.markdown).toBe(markdown);
		expect(notion.uploadImage).not.toHaveBeenCalled();
	});

	it("skips images over the size limit and unsupported files", async () => {
		(pluginMock.getLinkedMarkdownFile as jest.Mock)
			.mockReturnValueOnce(
				makeFile("big.png", MAX_IMAGE_UPLOAD_BYTES + 1)
			)
			.mockReturnValueOnce(makeFile("deck.pdf"));

		const result = await uploadLocalImages(
			pluginMock,
			noteMock,
			"![[big.png]] ![[deck.pdf]]"
		);

		expect(result.markdown).toBe("big.png deck.pdf");
		expect(result.skipped).toEqual(["big.png", "deck.pdf"]);
		expect(notion.uploadImage).not.toHaveBeenCalled();
	});

	it("falls back to text when the upload fails", async () => {
		(pluginMock.getLinkedMarkdownFile as jest.Mock).mockReturnValue(
			makeFile("a.png")
		);
		(notion.uploadImage as jest.Mock).mockResolvedValue({
			data: null,
			error: Error("boom"),
		});

		const result = await uploadLocalImages(
			pluginMock,
			noteMock,
			"![Alt](a.png)"
		);

		expect(result.markdown).toBe("Alt");
		expect(result.skipped).toEqual(["a.png"]);
	});
});

describe("pullFileFromNotion", () => {
	let pluginMock: NObsidian;
	let fileMock: TFile;

	beforeEach(() => {
		jest.clearAllMocks();
		pluginMock = new NObsidian(new App(), {} as PluginManifest);
		fileMock = new TFile();
		fileMock.basename = "Synced note";
		fileMock.stat.mtime = Date.parse("2024-01-01T00:00:00.000Z");
	});

	it("updates the note body and sync metadata from Notion", async () => {
		(pluginMock.getContent as jest.Mock).mockResolvedValueOnce({
			__content: "Local body",
			notionPageId: "page-id",
			notionPageUrl: "https://www.notion.so/page-id",
			notionLastEditedTime: "2024-01-01T00:00:00.000Z",
			obsidianLastSyncedAt: "2024-01-01T00:00:00.000Z",
		});
		(notion.retrievePageMarkdown as jest.Mock).mockResolvedValueOnce({
			data: {
				page: {
					id: "page-id",
					url: "https://www.notion.so/page-id",
					last_edited_time: "2024-01-02T00:00:00.000Z",
				},
				markdown: "Remote body",
			},
			error: null,
		});

		const result = await pullFileFromNotion(pluginMock, fileMock);

		expect(result.error).toBeNull();
		expect(pluginMock.updateMarkdownFile).toHaveBeenCalledWith(
			fileMock,
			expect.stringContaining("Remote body")
		);
		expect(pluginMock.updateMarkdownFile).toHaveBeenCalledWith(
			fileMock,
			expect.stringContaining(
				"notionLastEditedTime: 2024-01-02T00:00:00.000Z"
			)
		);
	});

	it("preserves the note's own front matter when pulling", async () => {
		(pluginMock.getContent as jest.Mock).mockResolvedValueOnce({
			__content: "Local body",
			notionPageId: "page-id",
			notionLastEditedTime: "2024-01-01T00:00:00.000Z",
			obsidianLastSyncedAt: "2024-01-01T00:00:00.000Z",
			customField: "keepme",
			aliases: ["one", "two"],
		});
		(notion.retrievePageMarkdown as jest.Mock).mockResolvedValueOnce({
			data: {
				page: {
					id: "page-id",
					last_edited_time: "2024-01-02T00:00:00.000Z",
				},
				markdown: "Remote body",
			},
			error: null,
		});

		const result = await pullFileFromNotion(pluginMock, fileMock);

		expect(result.error).toBeNull();
		const written = (pluginMock.updateMarkdownFile as jest.Mock).mock
			.calls[0][1];
		expect(written).toContain("customField: keepme");
		expect(written).toContain("Remote body");
	});

	it("returns a conflict when Notion and Obsidian both changed", async () => {
		fileMock.stat.mtime = Date.parse("2024-01-03T00:00:00.000Z");
		(pluginMock.getContent as jest.Mock).mockResolvedValueOnce({
			__content: "Local body",
			notionPageId: "page-id",
			notionLastEditedTime: "2024-01-01T00:00:00.000Z",
			obsidianLastSyncedAt: "2024-01-01T00:00:00.000Z",
		});
		(notion.retrievePageMarkdown as jest.Mock).mockResolvedValueOnce({
			data: {
				page: {
					id: "page-id",
					last_edited_time: "2024-01-02T00:00:00.000Z",
				},
				markdown: "Remote body",
			},
			error: null,
		});

		const result = await pullFileFromNotion(pluginMock, fileMock);

		expect(result.error?.message).toContain("Sync conflict");
		expect(pluginMock.updateMarkdownFile).not.toHaveBeenCalled();
	});

	it("overwrites local content when force-pulling through a conflict", async () => {
		fileMock.stat.mtime = Date.parse("2024-01-03T00:00:00.000Z");
		(pluginMock.getContent as jest.Mock).mockResolvedValueOnce({
			__content: "Local body",
			notionPageId: "page-id",
			notionLastEditedTime: "2024-01-01T00:00:00.000Z",
			obsidianLastSyncedAt: "2024-01-01T00:00:00.000Z",
		});
		(notion.retrievePageMarkdown as jest.Mock).mockResolvedValueOnce({
			data: {
				page: {
					id: "page-id",
					last_edited_time: "2024-01-02T00:00:00.000Z",
				},
				markdown: "Remote body",
			},
			error: null,
		});

		const result = await pullFileFromNotion(pluginMock, fileMock, {
			force: true,
		});

		expect(result.error).toBeNull();
		expect(pluginMock.updateMarkdownFile).toHaveBeenCalledWith(
			fileMock,
			expect.stringContaining("Remote body")
		);
	});
});

describe("getSyncStatus", () => {
	let pluginMock: NObsidian;
	let fileMock: TFile;

	beforeEach(() => {
		jest.clearAllMocks();
		pluginMock = new NObsidian(new App(), {} as PluginManifest);
		fileMock = new TFile();
		fileMock.basename = "Status note";
		fileMock.stat.mtime = Date.parse("2024-01-01T00:00:00.000Z");
	});

	it("reports an unlinked note without calling Notion", async () => {
		(pluginMock.getContent as jest.Mock).mockResolvedValueOnce({
			__content: "Body without front matter.",
		});

		const result = await getSyncStatus(pluginMock, fileMock);

		expect(result.error).toBeNull();
		expect(result.data.linked).toBe(false);
		expect(result.data.conflict).toBe(false);
		expect(notion.retrievePage).not.toHaveBeenCalled();
	});

	it("flags a conflict when both sides changed since the last sync", async () => {
		fileMock.stat.mtime = Date.parse("2024-01-03T00:00:00.000Z");
		(pluginMock.getContent as jest.Mock).mockResolvedValueOnce({
			__content: "Local body",
			notionPageId: "page-id",
			notionPageUrl: "https://www.notion.so/page-id",
			notionLastEditedTime: "2024-01-01T00:00:00.000Z",
			obsidianLastSyncedAt: "2024-01-01T00:00:00.000Z",
		});
		(notion.retrievePage as jest.Mock).mockResolvedValueOnce({
			data: {
				id: "page-id",
				last_edited_time: "2024-01-02T00:00:00.000Z",
			},
			error: null,
		});

		const result = await getSyncStatus(pluginMock, fileMock);

		expect(result.error).toBeNull();
		expect(result.data.linked).toBe(true);
		expect(result.data.hasLocalChanges).toBe(true);
		expect(result.data.hasRemoteChanges).toBe(true);
		expect(result.data.conflict).toBe(true);
	});
});
