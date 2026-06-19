/*
    Originally created by EasyChris (2022) as Upload2Notion.ts
    Renamed and modified by Quan Phan (2023)

    This file is part of nObsidian and is licensed under the GNU General Public License v3.0.
    Modifications include <brief description of modifications>.

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

import { requestUrl } from "obsidian";
import { markdownToBlocks } from "@tryfabric/martian";
import { PluginSettings, ServiceResult } from "./types";
import { getNotionPageMentionId } from "./utils";

// Notion requires every request to pin an API version. Keep this current with
// the latest stable release: https://developers.notion.com/reference/versioning
const NOTION_VERSION = "2022-06-28";
const MAX_BLOCKS_PER_APPEND = 100;

type NotionBlock = {
	id?: string;
	type?: string;
	has_children?: boolean;
	[key: string]: any;
};

type NotionPage = {
	id: string;
	url?: string;
	last_edited_time?: string;
	[key: string]: any;
};

const getBlockChildren = (block: NotionBlock): NotionBlock[] => {
	if (Array.isArray(block.children)) return block.children;
	if (!block.type) return [];

	const typedBlock = block[block.type];
	if (!typedBlock || !Array.isArray(typedBlock.children)) return [];

	return typedBlock.children;
};

const hasNestedChildren = (block: NotionBlock): boolean => {
	return getBlockChildren(block).some((child) => {
		const childChildren = getBlockChildren(child);
		return childChildren.length > 0 || hasNestedChildren(child);
	});
};

const removeBlockChildren = (block: NotionBlock): NotionBlock => {
	const blockWithoutChildren = { ...block };
	delete blockWithoutChildren.children;

	if (block.type && blockWithoutChildren[block.type]) {
		const typedBlock = { ...blockWithoutChildren[block.type] };
		delete typedBlock.children;
		blockWithoutChildren[block.type] = typedBlock;
	}

	return blockWithoutChildren;
};

const prepareBlockForAppend = (block: NotionBlock): NotionBlock => {
	return hasNestedChildren(block) ? removeBlockChildren(block) : block;
};

const chunkBlocks = (blocks: NotionBlock[]): NotionBlock[][] => {
	const chunks: NotionBlock[][] = [];
	for (let index = 0; index < blocks.length; index += MAX_BLOCKS_PER_APPEND) {
		chunks.push(blocks.slice(index, index + MAX_BLOCKS_PER_APPEND));
	}
	return chunks;
};

const appendBlockChildren = async (
	settings: PluginSettings,
	blockId: string,
	blocks: NotionBlock[]
) => {
	const notionAPIToken = settings.notionAPIToken;

	return requestUrl({
		url: `https://api.notion.com/v1/blocks/${blockId}/children`,
		method: "PATCH",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${notionAPIToken}`,
			"Notion-Version": NOTION_VERSION,
		},
		body: JSON.stringify({ children: blocks }),
	});
};

const appendBlocksRecursively = async (
	settings: PluginSettings,
	parentBlockId: string,
	blocks: NotionBlock[]
) => {
	let lastResponse = null;

	for (const chunk of chunkBlocks(blocks)) {
		const appendableBlocks = chunk.map(prepareBlockForAppend);
		lastResponse = await appendBlockChildren(
			settings,
			parentBlockId,
			appendableBlocks
		);

		const createdBlocks = lastResponse.json?.results || [];
		for (const [index, originalBlock] of chunk.entries()) {
			if (!hasNestedChildren(originalBlock)) continue;

			const createdBlockId = createdBlocks[index]?.id;
			if (!createdBlockId) {
				throw Error("Notion did not return an ID for a created block");
			}

			await appendBlocksRecursively(
				settings,
				createdBlockId,
				getBlockChildren(originalBlock)
			);
		}
	}

	return lastResponse;
};

const getAuthHeaders = (settings: PluginSettings) => ({
	Authorization: `Bearer ${settings.notionAPIToken}`,
	"Notion-Version": NOTION_VERSION,
});

const getJsonHeaders = (settings: PluginSettings) => ({
	"Content-Type": "application/json",
	...getAuthHeaders(settings),
});

const convertPageMentionLinks = (value: any): any => {
	if (Array.isArray(value)) {
		return value.map(convertPageMentionLinks);
	}

	if (!value || typeof value !== "object") return value;

	const notionPageId = getNotionPageMentionId(value.text?.link?.url || "");
	if (value.type === "text" && notionPageId) {
		return {
			type: "mention",
			mention: {
				type: "page",
				page: {
					id: notionPageId,
				},
			},
			annotations: value.annotations,
		};
	}

	const convertedValue = { ...value };
	for (const key of Object.keys(convertedValue)) {
		convertedValue[key] = convertPageMentionLinks(convertedValue[key]);
	}

	return convertedValue;
};

const richTextToMarkdown = (richText: any[] = []): string => {
	return richText
		.map((text) => {
			const plainText = text.plain_text || text.text?.content || "";
			if (text.href) return `[${plainText}](${text.href})`;
			if (text.text?.link?.url) {
				return `[${plainText}](${text.text.link.url})`;
			}
			return plainText;
		})
		.join("");
};

const indentMarkdown = (markdown: string): string => {
	return markdown
		.split("\n")
		.map((line) => (line ? `\t${line}` : line))
		.join("\n");
};

const blockToMarkdown = (block: NotionBlock): string => {
	const children = getBlockChildren(block)
		.map(blockToMarkdown)
		.filter(Boolean)
		.join("\n");
	const nestedMarkdown = children ? `\n${indentMarkdown(children)}` : "";

	switch (block.type) {
		case "paragraph":
			return `${richTextToMarkdown(block.paragraph?.rich_text)}${
				children ? `\n${children}` : ""
			}`.trim();
		case "heading_1":
			return `# ${richTextToMarkdown(block.heading_1?.rich_text)}`;
		case "heading_2":
			return `## ${richTextToMarkdown(block.heading_2?.rich_text)}`;
		case "heading_3":
			return `### ${richTextToMarkdown(block.heading_3?.rich_text)}`;
		case "bulleted_list_item":
			return `- ${richTextToMarkdown(
				block.bulleted_list_item?.rich_text
			)}${nestedMarkdown}`;
		case "numbered_list_item":
			return `1. ${richTextToMarkdown(
				block.numbered_list_item?.rich_text
			)}${nestedMarkdown}`;
		case "to_do":
			return `- [${block.to_do?.checked ? "x" : " "}] ${richTextToMarkdown(
				block.to_do?.rich_text
			)}${nestedMarkdown}`;
		case "quote":
			return `> ${richTextToMarkdown(block.quote?.rich_text)}${
				children ? `\n${children}` : ""
			}`;
		case "code":
			return `\`\`\`${block.code?.language || ""}\n${richTextToMarkdown(
				block.code?.rich_text
			)}\n\`\`\``;
		case "divider":
			return "---";
		default:
			return "";
	}
};

const blocksToMarkdown = (blocks: NotionBlock[]): string => {
	return blocks.map(blockToMarkdown).filter(Boolean).join("\n\n");
};

const retrievePage = async (
	settings: PluginSettings,
	notionPageId: string
): Promise<ServiceResult> => {
	let res = null;

	try {
		res = await requestUrl({
			url: `https://api.notion.com/v1/pages/${notionPageId}`,
			method: "GET",
			headers: getAuthHeaders(settings),
		});

		return { data: res.json, error: null };
	} catch (error) {
		return {
			data: res,
			error: Error(`Error retrieving Notion page: ${error}`),
		};
	}
};

const retrieveBlockChildren = async (
	settings: PluginSettings,
	blockId: string
): Promise<ServiceResult> => {
	let res = null;
	const blocks: NotionBlock[] = [];
	let startCursor: string | null = null;

	try {
		do {
			const cursorQuery = startCursor
				? `?start_cursor=${encodeURIComponent(startCursor)}`
				: "";
			res = await requestUrl({
				url: `https://api.notion.com/v1/blocks/${blockId}/children${cursorQuery}`,
				method: "GET",
				headers: getAuthHeaders(settings),
			});

			for (const block of res.json.results || []) {
				if (block.has_children) {
					const childrenResult = await retrieveBlockChildren(
						settings,
						block.id
					);
					if (childrenResult.error) return childrenResult;
					const typedBlock = block[block.type] || {};
					block[block.type] = {
						...typedBlock,
						children: childrenResult.data,
					};
				}
				blocks.push(block);
			}

			startCursor = res.json.has_more ? res.json.next_cursor : null;
		} while (startCursor);

		return { data: blocks, error: null };
	} catch (error) {
		return {
			data: res,
			error: Error(`Error retrieving Notion block children: ${error}`),
		};
	}
};

const retrievePageMarkdown = async (
	settings: PluginSettings,
	notionPageId: string
): Promise<ServiceResult> => {
	const pageResult = await retrievePage(settings, notionPageId);
	if (pageResult.error) return pageResult;

	const childrenResult = await retrieveBlockChildren(settings, notionPageId);
	if (childrenResult.error) return childrenResult;

	return {
		data: {
			page: pageResult.data as NotionPage,
			markdown: blocksToMarkdown(childrenResult.data),
		},
		error: null,
	};
};

const createEmptyPage = async (
	settings: PluginSettings,
	title: string,
	tags: string[] = []
): Promise<ServiceResult> => {
	let res = null;

	const { databaseID, allowTags, bannerUrl } = settings;

	const bodyString: any = {
		parent: { database_id: databaseID },
		properties: {
			Name: {
				title: [{ text: { content: title } }],
			},
			Tags: {
				multi_select:
					allowTags && tags ? tags.map((tag) => ({ name: tag })) : [],
			},
		},
	};

	if (bannerUrl) {
		bodyString.cover = {
			type: "external",
			external: { url: bannerUrl },
		};
	}

	try {
		res = await requestUrl({
			url: `https://api.notion.com/v1/pages`,
			method: "POST",
			headers: {
				...getJsonHeaders(settings),
			},
			body: JSON.stringify(bodyString),
		});

		return { data: res.json, error: null };
	} catch (error) {
		return {
			data: res,
			error: Error(`Error creating empty notion page ${error}`),
		};
	}
};

const addContentToPage = async (
	settings: PluginSettings,
	notionPageId: string,
	content: string
): Promise<ServiceResult> => {
	let res = null;

	const blocks = convertPageMentionLinks(markdownToBlocks(content));

	try {
		res = await appendBlocksRecursively(settings, notionPageId, blocks);
		return { data: res?.json || null, error: null };
	} catch (error) {
		return {
			data: res,
			error: Error(`Error adding content to Notion page: ${error}`),
		};
	}
};

const clearPageContent = async (
	settings: PluginSettings,
	notionPageId: string
): Promise<ServiceResult> => {
	try {
		// Retrieve the list of block children for the given page ID
		const listResponse = await requestUrl({
			url: `https://api.notion.com/v1/blocks/${notionPageId}/children`,
			method: "GET",
			headers: {
				...getAuthHeaders(settings),
			},
		});

		// Check if the response contains blocks and delete them if it does
		if (listResponse && listResponse.json && listResponse.json.results) {
			for (const block of listResponse.json.results) {
				// Each block has an ID, which you can use to delete it
				await requestUrl({
					url: `https://api.notion.com/v1/blocks/${block.id}`,
					method: "DELETE",
					headers: {
						...getAuthHeaders(settings),
					},
				});
			}
		}

		return {
			data: "Success! All content cleared from the Notion page.",
			error: null,
		};
	} catch (error) {
		return {
			data: null,
			error: Error(`Error clearing content from Notion page: ${error}`),
		};
	}
};

const uploadFileContent = async (
	settings: PluginSettings,
	notionPageId: string,
	content: string
): Promise<ServiceResult> => {
	const { error } = await clearPageContent(settings, notionPageId);
	if (error) {
		return { data: null, error };
	}

	const uploadResult = await addContentToPage(
		settings,
		notionPageId,
		content
	);

	return uploadResult;
};

const notion = {
	createEmptyPage,
	retrievePage,
	retrievePageMarkdown,
	uploadFileContent,
};

export default notion;
