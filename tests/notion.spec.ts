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
	notionOAuthClientId: "",
	notionOAuthClientSecret: "",
	notionOAuthRedirectUri: "",
	notionOAuthTokenExchangeUrl: "",
	notionOAuthAccessToken: "",
	notionOAuthWorkspaceId: "",
	notionOAuthWorkspaceName: "",
	notionOAuthRefreshToken: "",
	databaseID: "database-id",
	notionParentPageUrl: "",
	bannerUrl: "",
	notionWorkspaceID: "",
	allowTags: false,
	autoSync: false,
	autoSyncIntervalMinutes: 5,
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

	it("clears blocks across every page before re-uploading (pagination)", async () => {
		(markdownToBlocks as jest.Mock).mockReturnValue([]);
		const deletedIds: string[] = [];

		(requestUrl as jest.Mock).mockImplementation((options) => {
			if (options.method === "GET") {
				if (String(options.url).includes("start_cursor")) {
					return Promise.resolve({
						json: {
							results: [{ id: "b2" }],
							has_more: false,
							next_cursor: null,
						},
					});
				}
				return Promise.resolve({
					json: {
						results: [{ id: "b1" }],
						has_more: true,
						next_cursor: "cursor-2",
					},
				});
			}
			if (options.method === "DELETE") {
				deletedIds.push(String(options.url));
				return Promise.resolve({ json: {} });
			}
			return Promise.resolve({ json: { results: [] } });
		});

		const result = await notion.uploadFileContent(
			settings,
			"page-id",
			""
		);

		expect(result.error).toBeNull();
		expect(deletedIds.some((url) => url.endsWith("/blocks/b1"))).toBe(true);
		expect(deletedIds.some((url) => url.endsWith("/blocks/b2"))).toBe(true);
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
									url: "notional://notion-page/notion-page-id",
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
			"See [Linked note](notional://notion-page/notion-page-id)."
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

describe("notion.uploadImage", () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	it("creates a file upload and sends the bytes as multipart", async () => {
		(requestUrl as jest.Mock)
			.mockResolvedValueOnce({ status: 200, json: { id: "fu-1" } })
			.mockResolvedValueOnce({ status: 200, json: { status: "uploaded" } });

		const result = await notion.uploadImage(
			settings,
			"a.png",
			"image/png",
			new Uint8Array([1, 2, 3]).buffer
		);

		expect(result).toEqual({ data: "fu-1", error: null });
		const [[create], [send]] = (requestUrl as jest.Mock).mock.calls;
		expect(create.url).toBe("https://api.notion.com/v1/file_uploads");
		expect(JSON.parse(create.body)).toEqual({
			filename: "a.png",
			content_type: "image/png",
		});
		expect(send.url).toBe(
			"https://api.notion.com/v1/file_uploads/fu-1/send"
		);
		expect(send.contentType).toMatch(/^multipart\/form-data; boundary=/);
		const body = new TextDecoder().decode(send.body);
		expect(body).toContain('name="file"; filename="a.png"');
		expect(body).toContain("Content-Type: image/png");
	});

	it("returns an error when Notion does not finish the upload", async () => {
		(requestUrl as jest.Mock)
			.mockResolvedValueOnce({ status: 200, json: { id: "fu-1" } })
			.mockResolvedValueOnce({ status: 200, json: { status: "pending" } });

		const result = await notion.uploadImage(
			settings,
			"a.png",
			"image/png",
			new ArrayBuffer(1)
		);

		expect(result.data).toBeNull();
		expect(result.error?.message).toContain("upload status pending");
	});
});

describe("notion.uploadFileContent file upload images", () => {
	beforeEach(() => {
		jest.clearAllMocks();
		(requestUrl as jest.Mock).mockImplementation((options) =>
			Promise.resolve({
				json:
					options.method === "GET"
						? { results: [] }
						: { results: [{ id: "block-1" }] },
			})
		);
	});

	it("turns file upload marker images into file_upload image blocks", async () => {
		(markdownToBlocks as jest.Mock).mockReturnValue([
			{
				object: "block",
				type: "image",
				image: {
					type: "external",
					external: {
						url: "https://notional.invalid/file-upload/fu-1.png",
					},
				},
			},
			{
				object: "block",
				type: "image",
				image: {
					type: "external",
					external: { url: "https://example.com/remote.png" },
				},
			},
		]);

		const result = await notion.uploadFileContent(settings, "page-id", "x");

		expect(result.error).toBeNull();
		const [body] = getPatchBodies();
		expect(body.children[0].image).toEqual({
			type: "file_upload",
			file_upload: { id: "fu-1" },
		});
		expect(body.children[1].image.external.url).toBe(
			"https://example.com/remote.png"
		);
	});
});

describe("notion.uploadFileContent Obsidian syntax", () => {
	const text = (content: string, annotations = {}) => ({
		type: "text",
		annotations,
		text: { content },
	});

	beforeEach(() => {
		jest.clearAllMocks();
		(requestUrl as jest.Mock).mockImplementation((options) =>
			Promise.resolve({
				json:
					options.method === "GET"
						? { results: [] }
						: { results: [{ id: "block-1" }] },
			})
		);
	});

	it("turns [!type] quotes into Notion callouts", async () => {
		(markdownToBlocks as jest.Mock).mockReturnValue([
			{
				object: "block",
				type: "quote",
				quote: {
					rich_text: [text("")],
					children: [
						{
							object: "block",
							type: "paragraph",
							paragraph: {
								rich_text: [
									text("[!warning] Careful\nBody "),
									text("bold", { bold: true }),
								],
							},
						},
					],
				},
			},
			{
				object: "block",
				type: "quote",
				quote: {
					rich_text: [text("")],
					children: [
						{
							object: "block",
							type: "paragraph",
							paragraph: { rich_text: [text("plain quote")] },
						},
					],
				},
			},
		]);

		await notion.uploadFileContent(settings, "page-id", "x");

		const [body] = getPatchBodies();
		expect(body.children[0].type).toBe("callout");
		expect(body.children[0].callout).toEqual({
			rich_text: [
				{
					type: "text",
					text: { content: "Careful" },
					annotations: { bold: true },
				},
				{ type: "text", text: { content: "\n" } },
				text("Body "),
				text("bold", { bold: true }),
			],
			icon: { type: "emoji", emoji: "⚠️" },
			color: "yellow_background",
		});
		expect(body.children[1].type).toBe("quote");
	});

	it("uses the callout type as title and keeps extra paragraphs as children", async () => {
		(markdownToBlocks as jest.Mock).mockReturnValue([
			{
				object: "block",
				type: "quote",
				quote: {
					rich_text: [text("")],
					children: [
						paragraph("[!note]"),
						paragraph("Second paragraph"),
					],
				},
			},
		]);

		await notion.uploadFileContent(settings, "page-id", "x");

		const [body] = getPatchBodies();
		expect(body.children[0].callout.rich_text).toEqual([
			{
				type: "text",
				text: { content: "Note" },
				annotations: { bold: true },
			},
		]);
		expect(body.children[0].callout.children).toEqual([
			paragraph("Second paragraph"),
		]);
	});

	it("turns ==highlights== into yellow background text outside code", async () => {
		(markdownToBlocks as jest.Mock).mockReturnValue([
			{
				object: "block",
				type: "paragraph",
				paragraph: {
					rich_text: [
						text("a ==b== c", { italic: true }),
						text("==keep==", { code: true }),
					],
				},
			},
			{
				object: "block",
				type: "code",
				code: { rich_text: [text("x ==y==")], language: "js" },
			},
		]);

		await notion.uploadFileContent(settings, "page-id", "x");

		const [body] = getPatchBodies();
		expect(body.children[0].paragraph.rich_text).toEqual([
			text("a ", { italic: true }),
			text("b", { italic: true, color: "yellow_background" }),
			text(" c", { italic: true }),
			text("==keep==", { code: true }),
		]);
		expect(body.children[1].code.rich_text).toEqual([text("x ==y==")]);
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

describe("notion request retry", () => {
	beforeEach(() => jest.clearAllMocks());

	it("retries on a 429 then succeeds", async () => {
		(requestUrl as jest.Mock)
			.mockResolvedValueOnce({
				status: 429,
				headers: { "retry-after": "0" },
				json: { message: "rate limited" },
			})
			.mockResolvedValueOnce({ status: 200, json: { name: "ok" } });

		const result = await notion.validateToken(settings);

		expect(result.error).toBeNull();
		expect(result.data.name).toBe("ok");
		expect(requestUrl as jest.Mock).toHaveBeenCalledTimes(2);
	});

	it("does not retry a non-retryable status", async () => {
		(requestUrl as jest.Mock).mockResolvedValueOnce({
			status: 400,
			json: { message: "bad request" },
		});

		const result = await notion.validateToken(settings);

		expect(result.error).not.toBeNull();
		expect(requestUrl as jest.Mock).toHaveBeenCalledTimes(1);
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

	it("flags genuinely unknown blocks instead of dropping them, keeping text and URLs", async () => {
		(requestUrl as jest.Mock)
			.mockResolvedValueOnce({
				json: { id: "page-id", last_edited_time: "2024-01-01T00:00:00.000Z" },
			})
			.mockResolvedValueOnce({
				json: {
					results: [
						{
							id: "x1",
							type: "mystery_block",
							has_children: false,
							mystery_block: {
								rich_text: [{ plain_text: "Heads up" }],
								external: { url: "https://example.com/thing" },
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
			"> [!missing] Unsupported Notion block (mystery block): https://example.com/thing"
		);
		expect(result.data.markdown).toContain("Heads up");
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

describe("notion.retrievePageMarkdown rich blocks", () => {
	beforeEach(() => jest.clearAllMocks());

	it("converts image, callout, and equation blocks", async () => {
		(requestUrl as jest.Mock)
			.mockResolvedValueOnce({
				json: { id: "page-id", last_edited_time: "2024-01-01T00:00:00.000Z" },
			})
			.mockResolvedValueOnce({
				json: {
					results: [
						{
							id: "img",
							type: "image",
							has_children: false,
							image: {
								type: "file",
								file: { url: "https://x/img.png" },
								caption: [{ plain_text: "cap" }],
							},
						},
						{
							id: "call",
							type: "callout",
							has_children: false,
							callout: { rich_text: [{ plain_text: "Note text" }] },
						},
						{
							id: "eq",
							type: "equation",
							has_children: false,
							equation: { expression: "x^2" },
						},
					],
					has_more: false,
					next_cursor: null,
				},
			});

		const result = await notion.retrievePageMarkdown(settings, "page-id");

		expect(result.error).toBeNull();
		expect(result.data.markdown).toContain("![cap](https://x/img.png)");
		expect(result.data.markdown).toContain("> [!note] Note text");
		expect(result.data.markdown).toContain("$$x^2$$");
		expect(result.data.markdown).not.toContain("[!missing]");
	});

	it("reconstructs bold, italic, strikethrough, and inline code annotations", async () => {
		(requestUrl as jest.Mock)
			.mockResolvedValueOnce({
				json: { id: "page-id", last_edited_time: "2024-01-01T00:00:00.000Z" },
			})
			.mockResolvedValueOnce({
				json: {
					results: [
						{
							id: "p",
							type: "paragraph",
							has_children: false,
							paragraph: {
								rich_text: [
									{ plain_text: "bold", annotations: { bold: true } },
									{ plain_text: " and ", annotations: {} },
									{ plain_text: "italic", annotations: { italic: true } },
									{ plain_text: " and ", annotations: {} },
									{
										plain_text: "struck",
										annotations: { strikethrough: true },
									},
									{ plain_text: " and ", annotations: {} },
									{ plain_text: "code", annotations: { code: true } },
								],
							},
						},
						{
							id: "lp",
							type: "paragraph",
							has_children: false,
							paragraph: {
								rich_text: [
									{
										plain_text: "bold link",
										href: "https://example.com",
										annotations: { bold: true },
									},
								],
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
			"**bold** and *italic* and ~~struck~~ and `code`"
		);
		expect(result.data.markdown).toContain(
			"[**bold link**](https://example.com)"
		);
	});

	it("converts a table block into a markdown table", async () => {
		(requestUrl as jest.Mock)
			.mockResolvedValueOnce({
				json: { id: "page-id", last_edited_time: "2024-01-01T00:00:00.000Z" },
			})
			.mockResolvedValueOnce({
				json: {
					results: [
						{
							id: "tbl",
							type: "table",
							has_children: true,
							table: { table_width: 2, has_column_header: true },
						},
					],
					has_more: false,
					next_cursor: null,
				},
			})
			.mockResolvedValueOnce({
				json: {
					results: [
						{
							id: "r1",
							type: "table_row",
							has_children: false,
							table_row: {
								cells: [[{ plain_text: "A" }], [{ plain_text: "B" }]],
							},
						},
						{
							id: "r2",
							type: "table_row",
							has_children: false,
							table_row: {
								cells: [[{ plain_text: "1" }], [{ plain_text: "2" }]],
							},
						},
					],
					has_more: false,
					next_cursor: null,
				},
			});

		const result = await notion.retrievePageMarkdown(settings, "page-id");

		expect(result.error).toBeNull();
		expect(result.data.markdown).toBe(
			"| A | B |\n| --- | --- |\n| 1 | 2 |"
		);
	});
});
