jest.mock("obsidian");
jest.mock("@tryfabric/martian", () => ({
	markdownToBlocks: jest.fn(),
}));

import { markdownToBlocks } from "@tryfabric/martian";
import { requestUrl } from "obsidian";
import notion from "../service/notion";
import { PluginSettings } from "../service/types";

const settings: PluginSettings = {
	notionAPIToken: "secret",
	databaseID: "database-id",
	notionParentPageUrl: "",
	bannerUrl: "",
	notionWorkspaceID: "",
	allowTags: false,
};

const paragraph = (content: string) => ({
	object: "block",
	type: "paragraph",
	paragraph: {
		rich_text: [{ text: { content } }],
	},
});

const bullet = (content: string, children: any[] = []) => ({
	object: "block",
	type: "bulleted_list_item",
	bulleted_list_item: {
		rich_text: [{ text: { content } }],
		children: children.length ? children : undefined,
	},
});

const getPatchBodies = () =>
	(requestUrl as jest.Mock).mock.calls
		.filter(([options]) => options.method === "PATCH")
		.map(([options]) => JSON.parse(options.body));

describe("notion.uploadFileContent", () => {
	beforeEach(() => {
		jest.clearAllMocks();
		(requestUrl as jest.Mock).mockImplementation((options) => {
			if (options.method === "GET") {
				return Promise.resolve({ json: { results: [] } });
			}

			const { children } = JSON.parse(options.body);
			return Promise.resolve({
				json: {
					results: children.map((_: unknown, index: number) => ({
						id: `${options.url}-block-${index}`,
					})),
				},
			});
		});
	});

	it("appends deeply nested blocks with recursive child requests", async () => {
		(markdownToBlocks as jest.Mock).mockReturnValue([
			bullet("Level 1", [
				bullet("Level 2", [
					bullet("Level 3", [paragraph("Level 4")]),
				]),
			]),
		]);

		const result = await notion.uploadFileContent(
			settings,
			"page-id",
			"nested markdown"
		);

		const patchBodies = getPatchBodies();

		expect(result.error).toBeNull();
		expect(patchBodies).toHaveLength(3);
		expect(
			patchBodies[0].children[0].bulleted_list_item.children
		).toBeUndefined();
		expect(
			patchBodies[1].children[0].bulleted_list_item.children
		).toBeUndefined();
		expect(
			patchBodies[2].children[0].bulleted_list_item.children
		).toHaveLength(1);
	});

	it("chunks append requests at Notion's 100 block limit", async () => {
		(markdownToBlocks as jest.Mock).mockReturnValue(
			Array.from({ length: 101 }, (_, index) =>
				paragraph(`Paragraph ${index}`)
			)
		);

		const result = await notion.uploadFileContent(
			settings,
			"page-id",
			"large markdown"
		);

		const patchBodies = getPatchBodies();

		expect(result.error).toBeNull();
		expect(patchBodies).toHaveLength(2);
		expect(patchBodies[0].children).toHaveLength(100);
		expect(patchBodies[1].children).toHaveLength(1);
	});

	it("converts internal page mention marker links into Notion mention rich text", async () => {
		(markdownToBlocks as jest.Mock).mockReturnValue([
			{
				object: "block",
				type: "paragraph",
				paragraph: {
					rich_text: [
						{
							type: "text",
							annotations: {
								bold: false,
								strikethrough: false,
								underline: false,
								italic: false,
								code: false,
								color: "default",
							},
							text: {
								content: "Linked note",
								link: {
									type: "url",
									url: "nobsidian://notion-page/notion-page-id",
								},
							},
						},
					],
				},
			},
		]);

		const result = await notion.uploadFileContent(
			settings,
			"page-id",
			"See [Linked note](nobsidian://notion-page/notion-page-id)."
		);
		const body = getPatchBodies()[0];

		expect(result.error).toBeNull();
		expect(body.children[0].paragraph.rich_text[0]).toEqual({
			type: "mention",
			mention: {
				type: "page",
				page: {
					id: "notion-page-id",
				},
			},
			annotations: {
				bold: false,
				strikethrough: false,
				underline: false,
				italic: false,
				code: false,
				color: "default",
			},
		});
	});
});

describe("notion.retrievePageMarkdown", () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	it("retrieves page metadata and converts child blocks to markdown", async () => {
		(requestUrl as jest.Mock)
			.mockResolvedValueOnce({
				json: {
					id: "page-id",
					url: "https://www.notion.so/page-id",
					last_edited_time: "2024-01-02T00:00:00.000Z",
				},
			})
			.mockResolvedValueOnce({
				json: {
					results: [
						{
							id: "heading-id",
							type: "heading_2",
							heading_2: {
								rich_text: [{ plain_text: "Section" }],
							},
						},
						{
							id: "todo-id",
							type: "to_do",
							to_do: {
								checked: true,
								rich_text: [{ plain_text: "Done" }],
							},
						},
					],
					has_more: false,
					next_cursor: null,
				},
			});

		const result = await notion.retrievePageMarkdown(settings, "page-id");

		expect(result.error).toBeNull();
		expect(result.data.markdown).toBe("## Section\n\n- [x] Done");
		expect(result.data.page.last_edited_time).toBe(
			"2024-01-02T00:00:00.000Z"
		);
	});
});

describe("notion.validateToken", () => {
	beforeEach(() => jest.clearAllMocks());

	it("returns the connection user on success", async () => {
		(requestUrl as jest.Mock).mockResolvedValueOnce({
			json: { name: "My Connection", type: "bot" },
		});

		const result = await notion.validateToken(settings);

		expect(result.error).toBeNull();
		expect(result.data.name).toBe("My Connection");
		expect((requestUrl as jest.Mock).mock.calls[0][0].url).toContain(
			"/v1/users/me"
		);
	});

	it("returns an error when the request fails", async () => {
		(requestUrl as jest.Mock).mockRejectedValueOnce(new Error("401"));

		const result = await notion.validateToken(settings);

		expect(result.error).not.toBeNull();
	});
});

describe("notion.createDatabase", () => {
	beforeEach(() => jest.clearAllMocks());

	it("posts a database under the parent page with a title property", async () => {
		(requestUrl as jest.Mock).mockResolvedValueOnce({
			json: { id: "new-db-id", object: "database" },
		});

		const result = await notion.createDatabase(
			settings,
			"parent-page-id",
			"Obsidian Notes"
		);

		expect(result.error).toBeNull();
		expect(result.data.id).toBe("new-db-id");

		const call = (requestUrl as jest.Mock).mock.calls[0][0];
		expect(call.method).toBe("POST");
		expect(call.url).toContain("/v1/databases");
		const body = JSON.parse(call.body);
		expect(body.parent.page_id).toBe("parent-page-id");
		expect(body.title[0].text.content).toBe("Obsidian Notes");
		expect(body.properties.Name.title).toBeDefined();
	});
});

describe("notion.retrievePageMarkdown unsupported blocks", () => {
	beforeEach(() => jest.clearAllMocks());

	it("flags unsupported blocks instead of dropping them and keeps text and URLs", async () => {
		(requestUrl as jest.Mock)
			.mockResolvedValueOnce({
				json: { id: "page-id", last_edited_time: "2024-01-01T00:00:00.000Z" },
			})
			.mockResolvedValueOnce({
				json: {
					results: [
						{
							id: "callout-id",
							type: "callout",
							has_children: false,
							callout: { rich_text: [{ plain_text: "Heads up" }] },
						},
						{
							id: "image-id",
							type: "image",
							has_children: false,
							image: {
								type: "file",
								file: { url: "https://files.notion/img.png" },
							},
						},
					],
					has_more: false,
					next_cursor: null,
				},
			});

		const result = await notion.retrievePageMarkdown(settings, "page-id");

		expect(result.error).toBeNull();
		expect(result.data.markdown).toContain(
			"> [!missing] Unsupported Notion block (callout)"
		);
		expect(result.data.markdown).toContain("Heads up");
		expect(result.data.markdown).toContain(
			"> [!missing] Unsupported Notion block (image): https://files.notion/img.png"
		);
	});

	it("keeps consecutive list items tight but separates other blocks", async () => {
		(requestUrl as jest.Mock)
			.mockResolvedValueOnce({
				json: { id: "page-id", last_edited_time: "2024-01-01T00:00:00.000Z" },
			})
			.mockResolvedValueOnce({
				json: {
					results: [
						{
							id: "p1",
							type: "paragraph",
							has_children: false,
							paragraph: { rich_text: [{ plain_text: "Intro" }] },
						},
						{
							id: "b1",
							type: "bulleted_list_item",
							has_children: false,
							bulleted_list_item: { rich_text: [{ plain_text: "one" }] },
						},
						{
							id: "b2",
							type: "bulleted_list_item",
							has_children: false,
							bulleted_list_item: { rich_text: [{ plain_text: "two" }] },
						},
					],
					has_more: false,
					next_cursor: null,
				},
			});

		const result = await notion.retrievePageMarkdown(settings, "page-id");

		expect(result.error).toBeNull();
		expect(result.data.markdown).toBe("Intro\n\n- one\n- two");
	});

	it("silently skips navigational blocks but keeps real content", async () => {
		(requestUrl as jest.Mock)
			.mockResolvedValueOnce({
				json: { id: "page-id", last_edited_time: "2024-01-01T00:00:00.000Z" },
			})
			.mockResolvedValueOnce({
				json: {
					results: [
						{
							id: "breadcrumb-id",
							type: "breadcrumb",
							has_children: false,
							breadcrumb: {},
						},
						{
							id: "para-id",
							type: "paragraph",
							has_children: false,
							paragraph: { rich_text: [{ plain_text: "Hello" }] },
						},
					],
					has_more: false,
					next_cursor: null,
				},
			});

		const result = await notion.retrievePageMarkdown(settings, "page-id");

		expect(result.error).toBeNull();
		expect(result.data.markdown).toBe("Hello");
		expect(result.data.markdown).not.toContain("[!missing]");
		expect(result.data.markdown).not.toContain("breadcrumb");
	});
});
