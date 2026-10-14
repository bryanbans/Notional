/*
    Created by Quan Phan (2023). Reused functions from EasyChris (2022).

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

import * as yaml from "yaml";
import { addIcon } from "obsidian";
import { NoticeMsg } from "../static/message";
import { icons } from "../static/icon";
import { MarkdownWithFrontMatter } from "./types";

const NOTION_PAGE_MENTION_URL_PREFIX = "notional://notion-page/";

// Personal fork: only Obsidian -> Notion pushes. Pull, two-way sync, folder
// upload and auto-sync are disabled so Notion can never overwrite the vault.
export const PUSH_ONLY = true;

export type WikiLink = {
	rawLink: string;
	pageName: string;
	displayName: string;
};

/**
 *
 * @param lang
 * @returns
 */
export const NoticeMessageConfig = (
	lang: string
): { [key: string]: string } => {
	return NoticeMsg[lang];
};

/**
 *
 */
export const addIcons = (): void => {
	Object.keys(icons).forEach((key) => {
		addIcon(key, icons[key]);
	});
};

/**
 * Parse front matter (result of yaml.loadFront) back into markdown
 * @param contentWithFrontMatter
 * @returns
 */
export const fromYamlFrontMatterToMarkdown = (
	contentWithFrontMatter: MarkdownWithFrontMatter
): string => {
	const { __content: mainContent, ...frontMatter } = contentWithFrontMatter;
	/**
	 * Converting the YAML front matter into a string.
	 * Removing any trailing newline from the YAML string.
	 * Remove all leading newline in the main content.
	 */
	const yamlhead = yaml.stringify(frontMatter).replace(/\n$/, "");
	const __content_remove_n = mainContent.replace(/^\n/, "");

	// Concatenate to create final markdown
	const processedMarkdown = `---\n${yamlhead}\n---\n${__content_remove_n}`;

	return processedMarkdown;
};

/**
 *
 * @param notionPageUrl
 * @param notionWorkspaceId
 * @returns
 */
/**
 * Parse a markdown file into its YAML front matter and body using the `yaml`
 * package. Replaces yaml-front-matter, whose bundled js-yaml carried a
 * vulnerability advisory.
 */
export const parseFrontMatter = (content: string): MarkdownWithFrontMatter => {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
	if (!match) return { __content: content };

	const parsed = yaml.parse(match[1]) as Record<string, unknown> | null;
	return { ...(parsed ?? {}), __content: match[2] };
};

export const updateNotionPageUrlWithWorkspaceId = (
	notionPageUrl: string,
	notionWorkspaceId: string
): string => {
	if (notionWorkspaceId == "") return notionPageUrl;

	return notionPageUrl.replace(
		"www.notion.so",
		`${notionWorkspaceId}.notion.site`
	);
};

export const getWikiLinksFromMarkdown = (markdown: string): WikiLink[] => {
	const obsidianLinkRegex = /\[\[([^\]]+)\]\]/g;
	const linksByRawLink = new Map<string, WikiLink>();
	let match;

	while ((match = obsidianLinkRegex.exec(markdown)) !== null) {
		const rawLink = match[1];
		const [target, alias] = rawLink.split("|");
		const pageName = getBasenameFromPath(target.split("#")[0]);

		linksByRawLink.set(rawLink, {
			rawLink,
			pageName,
			displayName: alias || pageName,
		});
	}

	return Array.from(linksByRawLink.values());
};

export const replaceWikiWithHyperLink = (
	markdown: string,
	wikiName: string,
	hyperLinkName: string,
	hyperlink: string
) => {
	return markdown.replace(
		new RegExp(
			`\\[\\[${wikiName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\]`,
			"g"
		),
		`[${hyperLinkName}](${hyperlink})`
	);
};

export const replaceWikiWithText = (
	markdown: string,
	wikiName: string,
	text: string
) => {
	return markdown.replace(
		new RegExp(
			`\\[\\[${wikiName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\]`,
			"g"
		),
		() => text
	);
};

// Marker for an image that was sent through Notion's File Upload API. It ends
// in ".png" so Martian (strictImageUrls) keeps it as an image block;
// service/notion.ts swaps it for a file_upload image before appending.
const FILE_UPLOAD_IMAGE_URL_PREFIX = "https://notional.invalid/file-upload/";

export const createFileUploadImageUrl = (fileUploadId: string): string => {
	return `${FILE_UPLOAD_IMAGE_URL_PREFIX}${encodeURIComponent(fileUploadId)}.png`;
};

export const getFileUploadImageId = (url: string): string | null => {
	if (!url.startsWith(FILE_UPLOAD_IMAGE_URL_PREFIX) || !url.endsWith(".png"))
		return null;

	return decodeURIComponent(
		url.slice(FILE_UPLOAD_IMAGE_URL_PREFIX.length, -".png".length)
	);
};

export const createNotionPageMentionUrl = (pageId: string): string => {
	return `${NOTION_PAGE_MENTION_URL_PREFIX}${encodeURIComponent(pageId)}`;
};

export const getNotionPageMentionId = (url: string): string | null => {
	if (!url.startsWith(NOTION_PAGE_MENTION_URL_PREFIX)) return null;

	return decodeURIComponent(
		url.slice(NOTION_PAGE_MENTION_URL_PREFIX.length)
	);
};

/**
 * Pull a Notion object ID out of a pasted page/database link (or a raw ID).
 *
 * Notion IDs are 32 hex characters, shown either bare or as a hyphenated UUID,
 * and usually sit at the end of a URL path. The query string is dropped first
 * so a database view ID (`?v=...`) is never mistaken for the object ID.
 *
 * @returns the ID as a hyphenated UUID, or null if none was found.
 */
export const extractNotionId = (input: string): string | null => {
	if (!input) return null;

	const withoutQuery = input.trim().split("?")[0];
	const matches = withoutQuery.match(
		/[0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g
	);
	if (!matches || matches.length === 0) return null;

	const raw = matches[matches.length - 1].replace(/-/g, "").toLowerCase();
	if (raw.length !== 32) return null;

	return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
};

export const getBasenameFromPath = (filePath: string): string => {
	// Extract the file name from the full path
	const fileName = filePath.split("/").pop();

	// Remove the file extension and return the base name
	return fileName ? fileName.replace(/\.[^/.]+$/, "") : "";
};
