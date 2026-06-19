import { TFile } from "obsidian";
import NObsidian from "main";
import { MarkdownWithFrontMatter, ServiceResult } from "./types";
import notion from "./notion";
import {
	updateNotionPageUrlWithWorkspaceId,
	fromYamlFrontMatterToMarkdown,
	createNotionPageMentionUrl,
	getWikiLinksFromMarkdown,
	replaceWikiWithHyperLink,
} from "./utils";

export const uploadFile = async (
	plugin: NObsidian,
	file: TFile
): Promise<ServiceResult> => {
	const contentWithFrontMatter = await initializeNotionPage(plugin, file);

	const content = await convertObsidianLinks(
		plugin,
		contentWithFrontMatter.__content
	);

	if (contentWithFrontMatter.notionPageId) {
		const uploadResult = await notion.uploadFileContent(
			plugin.settings,
			contentWithFrontMatter.notionPageId,
			content
		);

		return uploadResult;
	}

	return { data: null, error: Error("Something happened") };
};

export const initializeNotionPage = async (
	plugin: NObsidian,
	file: TFile
): Promise<MarkdownWithFrontMatter> => {
	const contentWithFrontMatter = await plugin.getContent(file);
	const settings = plugin.settings;
	const notionWorkspaceID = settings.notionWorkspaceID;

	if (!contentWithFrontMatter.notionPageId) {
		const { data } = await notion.createEmptyPage(
			settings,
			file.basename
		);
		const { url: rawNotionPageUrl, id: notionPageId } = data;

		const notionPageUrl = updateNotionPageUrlWithWorkspaceId(
			rawNotionPageUrl,
			notionWorkspaceID
		);

		contentWithFrontMatter.notionPageId = notionPageId;
		contentWithFrontMatter.notionPageUrl = notionPageUrl;

		const processedMarkdown = fromYamlFrontMatterToMarkdown(
			contentWithFrontMatter
		);

		plugin.updateMarkdownFile(file, processedMarkdown);
	}

	return contentWithFrontMatter;
};

/**
 * Convert Obsidian wiki-link into a Notion page mention marker.
 *
 * The marker is emitted as a markdown link so Martian preserves it in rich text.
 * service/notion.ts converts that marker into a Notion page mention before
 * appending blocks.
 *
 * @param markdown Original markdown content of an Obsidian markdown file
 * @returns Same markdown content, with wiki-link turned into mention markers.
 */
export const convertObsidianLinks = async (
	plugin: NObsidian,
	markdown: string
): Promise<string> => {
	const links = getWikiLinksFromMarkdown(markdown);
	let updatedMarkdown = markdown;

	for (const link of links) {
		let file: TFile | undefined;

		if (plugin.fileNameToFile.has(link.pageName)) {
			file = plugin.fileNameToFile.get(link.pageName);
		}

		// if file doesn't exist, create it
		if (!file) file = await plugin.createEmptyMarkdownFile(link.pageName);
		if (!file) continue;

		// If file exists but doesn't have a corresponding notion page
		// create an empty notion page
		const contentWithFrontMatter = await initializeNotionPage(
			plugin,
			file
		);
		const notionPageId = contentWithFrontMatter.notionPageId;

		if (notionPageId)
			updatedMarkdown = replaceWikiWithHyperLink(
				updatedMarkdown,
				link.rawLink,
				link.displayName,
				createNotionPageMentionUrl(notionPageId)
			);
	}

	return updatedMarkdown;
};
