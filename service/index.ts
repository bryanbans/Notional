import { TFile } from "obsidian";
import NObsidian from "main";
import { MarkdownWithFrontMatter, ServiceResult } from "./types";
import notion from "./notion";
import {
	updateNotionPageUrlWithWorkspaceId,
	fromYamlFrontMatterToMarkdown,
	getWikiLinkFromMarkdown,
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

const inFlightPageInitializations = new WeakMap<
	NObsidian,
	Map<string, Promise<MarkdownWithFrontMatter>>
>();

export const initializeNotionPage = async (
	plugin: NObsidian,
	file: TFile
): Promise<MarkdownWithFrontMatter> => {
	let pluginInitializations = inFlightPageInitializations.get(plugin);
	if (!pluginInitializations) {
		pluginInitializations = new Map();
		inFlightPageInitializations.set(plugin, pluginInitializations);
	}

	const existingInitialization = pluginInitializations.get(file.basename);
	if (existingInitialization) return existingInitialization;

	const initialization = initializeNotionPageContent(plugin, file).finally(
		() => {
			pluginInitializations.delete(file.basename);
		}
	);
	pluginInitializations.set(file.basename, initialization);

	return initialization;
};

const initializeNotionPageContent = async (
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

export const runWithConcurrency = async <T, R>(
	items: T[],
	concurrency: number,
	worker: (item: T, index: number) => Promise<R>
): Promise<R[]> => {
	if (!Number.isInteger(concurrency) || concurrency < 1) {
		throw Error("Concurrency must be a positive integer");
	}

	const results: R[] = new Array(items.length);
	let nextIndex = 0;

	const runWorker = async () => {
		while (nextIndex < items.length) {
			const index = nextIndex;
			nextIndex += 1;
			results[index] = await worker(items[index], index);
		}
	};

	const workers = Array.from(
		{ length: Math.min(concurrency, items.length) },
		() => runWorker()
	);
	await Promise.all(workers);

	return results;
};

/**
 * Convert Obsidian wiki-link into hyperlink.
 *
 * The hyperlink will have the same name as the wiki-link, but it will link
 * to the corresponding Notion page.
 *
 * We parse wiki-link into hyperlink because Notion doesn't understand wiki-link
 * and we haven't built a parser from wiki-link to Notion internal page mention.
 *
 * @param markdown Original markdown content of an Obsidian markdown file
 * @returns Same markdown content, with wiki-link turned into hyperlink.
 */
export const convertObsidianLinks = async (
	plugin: NObsidian,
	markdown: string
): Promise<string> => {
	const links = getWikiLinkFromMarkdown(markdown);
	let updatedMarkdown = markdown;

	for (const pageName of links) {
		let file: TFile | undefined;

		if (plugin.fileNameToFile.has(pageName)) {
			file = plugin.fileNameToFile.get(pageName);
		}

		// if file doesn't exist, create it
		if (!file) file = await plugin.createEmptyMarkdownFile(pageName);
		if (!file) continue;

		// If file exists but doesn't have a corresponding notion page
		// create an empty notion page
		const contentWithFrontMatter = await initializeNotionPage(
			plugin,
			file
		);
		const notionPageUrl = contentWithFrontMatter.notionPageUrl;

		if (notionPageUrl)
			updatedMarkdown = replaceWikiWithHyperLink(
				updatedMarkdown,
				pageName,
				pageName,
				notionPageUrl
			);
	}

	return updatedMarkdown;
};
