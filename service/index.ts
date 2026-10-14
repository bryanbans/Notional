import { Notice, TFile } from "obsidian";
import NObsidian from "main";
import {
	MarkdownWithFrontMatter,
	NotionPage,
	NotionPageMarkdown,
	ServiceResult,
	SyncStatus,
} from "./types";
import notion from "./notion";
import {
	updateNotionPageUrlWithWorkspaceId,
	fromYamlFrontMatterToMarkdown,
	createNotionPageMentionUrl,
	createFileUploadImageUrl,
	getWikiLinksFromMarkdown,
	replaceWikiWithHyperLink,
	replaceWikiWithText,
} from "./utils";

const errorResult = <T>(error: Error, data: unknown = null): ServiceResult<T> => ({
	data: data as T,
	error,
});

export const uploadFile = async (
	plugin: NObsidian,
	file: TFile
): Promise<ServiceResult> => {
	const contentWithFrontMatter = await initializeNotionPage(plugin, file);

	const { markdown: contentWithImages, skipped } = await uploadLocalImages(
		plugin,
		file,
		contentWithFrontMatter.__content
	);
	if (skipped.length)
		new Notice(`Not uploaded to Notion: ${skipped.join(", ")}`, 8000);

	const content = await convertObsidianLinks(
		plugin,
		file,
		contentWithImages
	);

	if (contentWithFrontMatter.notionPageId) {
		const uploadResult = await notion.uploadFileContent(
			plugin.settings,
			contentWithFrontMatter.notionPageId,
			content
		);

		if (!uploadResult.error) {
			const pageResult = await notion.retrievePage(
				plugin.settings,
				contentWithFrontMatter.notionPageId
			);
			if (pageResult.error) return pageResult;

			await updateSyncMetadata(
				plugin,
				file,
				contentWithFrontMatter,
				pageResult.data
			);
		}

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
		const createPageResult = await notion.createEmptyPage(
			settings,
			file.basename
		);
		if (createPageResult.error) throw createPageResult.error;

		const data = createPageResult.data;
		const { url: rawNotionPageUrl, id: notionPageId } = data;
		if (!rawNotionPageUrl || !notionPageId) {
			throw Error("Notion did not return a page URL or ID");
		}

		const notionPageUrl = updateNotionPageUrlWithWorkspaceId(
			rawNotionPageUrl,
			notionWorkspaceID
		);

		contentWithFrontMatter.notionPageId = notionPageId;
		contentWithFrontMatter.notionPageUrl = notionPageUrl;
		contentWithFrontMatter.notionLastEditedTime = data.last_edited_time;
		contentWithFrontMatter.obsidianLastSyncedAt =
			new Date().toISOString();

		const processedMarkdown = fromYamlFrontMatterToMarkdown(
			contentWithFrontMatter
		);

		await plugin.updateMarkdownFile(file, processedMarkdown);
	}

	return contentWithFrontMatter;
};

const updateSyncMetadata = async (
	plugin: NObsidian,
	file: TFile,
	contentWithFrontMatter: MarkdownWithFrontMatter,
	notionPage: NotionPage,
	content = contentWithFrontMatter.__content
) => {
	const processedMarkdown = fromYamlFrontMatterToMarkdown({
		...contentWithFrontMatter,
		__content: content,
		notionPageUrl:
			notionPage.url || contentWithFrontMatter.notionPageUrl,
		notionLastEditedTime:
			notionPage.last_edited_time ||
			contentWithFrontMatter.notionLastEditedTime,
		obsidianLastSyncedAt: new Date().toISOString(),
	});

	await plugin.updateMarkdownFile(file, processedMarkdown);
};

const isAfter = (current?: string, previous?: string): boolean => {
	if (!current || !previous) return Boolean(current);
	return Date.parse(current) > Date.parse(previous);
};

const hasLocalChangesSinceLastSync = (
	file: TFile,
	contentWithFrontMatter: MarkdownWithFrontMatter
): boolean => {
	const lastSyncedAt = contentWithFrontMatter.obsidianLastSyncedAt;
	if (!lastSyncedAt || !file.stat?.mtime) return false;

	return file.stat.mtime > Date.parse(lastSyncedAt) + 1000;
};

const hasNotionChangesSinceLastSync = (
	contentWithFrontMatter: MarkdownWithFrontMatter,
	notionPage: NotionPage
): boolean => {
	return isAfter(
		notionPage.last_edited_time,
		contentWithFrontMatter.notionLastEditedTime
	);
};

/**
 * Inspect the sync state of a note without mutating anything.
 *
 * Local-change detection is cheap (file mtime vs. recorded sync time), but
 * remote-change detection needs a Notion round-trip, so this issues one
 * retrievePage call when the note is linked. The GUI uses this to render
 * status and to decide whether a conflict needs user resolution.
 */
export const getSyncStatus = async (
	plugin: NObsidian,
	file: TFile
): Promise<ServiceResult<SyncStatus>> => {
	const contentWithFrontMatter = await plugin.getContent(file);
	const notionPageId = contentWithFrontMatter.notionPageId;

	if (!notionPageId) {
		const status: SyncStatus = {
			linked: false,
			hasLocalChanges: false,
			hasRemoteChanges: false,
			conflict: false,
		};
		return { data: status, error: null };
	}

	const pageResult = await notion.retrievePage(plugin.settings, notionPageId);
	if (pageResult.error) {
		return errorResult(pageResult.error, pageResult.data);
	}
	const notionPage = pageResult.data;

	const hasRemoteChanges = hasNotionChangesSinceLastSync(
		contentWithFrontMatter,
		notionPage
	);
	const hasLocalChanges = hasLocalChangesSinceLastSync(
		file,
		contentWithFrontMatter
	);

	const status: SyncStatus = {
		linked: true,
		notionPageId,
		notionPageUrl: contentWithFrontMatter.notionPageUrl,
		obsidianLastSyncedAt: contentWithFrontMatter.obsidianLastSyncedAt,
		notionLastEditedTime: notionPage.last_edited_time,
		hasLocalChanges,
		hasRemoteChanges,
		conflict: hasLocalChanges && hasRemoteChanges,
	};

	return { data: status, error: null };
};

export const pullFileFromNotion = async (
	plugin: NObsidian,
	file: TFile,
	options: { force?: boolean } = {}
): Promise<ServiceResult<NotionPageMarkdown>> => {
	const contentWithFrontMatter = await plugin.getContent(file);
	const notionPageId = contentWithFrontMatter.notionPageId;

	if (!notionPageId) {
		return {
			...errorResult<NotionPageMarkdown>(
				Error("Missing notionPageId for ")
			),
		};
	}

	const notionPageResult = await notion.retrievePageMarkdown(
		plugin.settings,
		notionPageId
	);
	if (notionPageResult.error) return notionPageResult;

	const { page, markdown } = notionPageResult.data;
	const hasRemoteChanges = hasNotionChangesSinceLastSync(
		contentWithFrontMatter,
		page
	);
	const hasLocalChanges = hasLocalChangesSinceLastSync(
		file,
		contentWithFrontMatter
	);

	if (!options.force && hasRemoteChanges && hasLocalChanges) {
		return {
			...errorResult<NotionPageMarkdown>(
				Error("Sync conflict: both Obsidian and Notion changed ")
			),
		};
	}

	await updateSyncMetadata(
		plugin,
		file,
		contentWithFrontMatter,
		page,
		markdown
	);

	return { data: notionPageResult.data, error: null };
};

export const syncFile = async (
	plugin: NObsidian,
	file: TFile
): Promise<ServiceResult> => {
	const contentWithFrontMatter = await plugin.getContent(file);
	const notionPageId = contentWithFrontMatter.notionPageId;

	if (!notionPageId) return uploadFile(plugin, file);

	const pageResult = await notion.retrievePage(plugin.settings, notionPageId);
	if (pageResult.error) return pageResult;
	const notionPage = pageResult.data;

	const hasRemoteChanges = hasNotionChangesSinceLastSync(
		contentWithFrontMatter,
		notionPage
	);
	const hasLocalChanges = hasLocalChangesSinceLastSync(
		file,
		contentWithFrontMatter
	);

	if (hasRemoteChanges && hasLocalChanges) {
		return {
			data: null,
			error: Error("Sync conflict: both Obsidian and Notion changed "),
		};
	}

	if (hasRemoteChanges) return pullFileFromNotion(plugin, file);

	return uploadFile(plugin, file);
};

export const runWithConcurrency = async <T, R>(
	items: T[],
	concurrency: number,
	worker: (item: T, index: number) => Promise<R>
): Promise<R[]> => {
	if (!Number.isInteger(concurrency) || concurrency < 1) {
		throw Error("Concurrency must be a positive integer");
	}

	const results: R[] = [];
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

const IMAGE_CONTENT_TYPES: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	svg: "image/svg+xml",
	bmp: "image/bmp",
	tif: "image/tiff",
	tiff: "image/tiff",
	heic: "image/heic",
};

// Notion's per-file upload limit on the Free plan.
export const MAX_IMAGE_UPLOAD_BYTES = 5 * 1024 * 1024;

const LOCAL_IMAGE_REGEX =
	/!\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]|!\[([^\]]*)\]\((?:<([^>]+)>|([^)\s]+))(?:\s+"[^"]*")?\)/g;

const safeDecodeURI = (value: string): string => {
	try {
		return decodeURI(value);
	} catch {
		return value;
	}
};

/**
 * Upload local images (![[img.png]] or ![alt](relative/img.png)) through
 * Notion's File Upload API and point the markdown at the uploads.
 *
 * Remote image URLs and note embeds are left as-is. Images that are missing,
 * unsupported, over the size limit, or fail to upload become plain text and
 * are reported in `skipped`.
 */
export const uploadLocalImages = async (
	plugin: NObsidian,
	sourceFile: TFile,
	markdown: string
): Promise<{ markdown: string; skipped: string[] }> => {
	const skipped: string[] = [];
	const uploadsByPath = new Map<string, string | null>();
	let result = "";
	let lastIndex = 0;

	for (const match of markdown.matchAll(LOCAL_IMAGE_REGEX)) {
		const index = match.index ?? 0;
		result += markdown.slice(lastIndex, index);
		lastIndex = index + match[0].length;

		const isEmbed = match[1] !== undefined;
		const target = isEmbed
			? match[1].trim()
			: safeDecodeURI(match[3] ?? match[4]);
		const alt = isEmbed ? "" : match[2];

		if (!isEmbed && /^[a-z][a-z0-9+.-]*:/i.test(target)) {
			result += match[0];
			continue;
		}

		const file = plugin.getLinkedMarkdownFile(target, sourceFile.path);
		if (!file || file.extension === "md") {
			// Unresolved embeds are left for convertObsidianLinks (plain text).
			if (!file && !isEmbed) skipped.push(target);
			result += file || isEmbed ? match[0] : alt || target;
			continue;
		}

		const contentType = IMAGE_CONTENT_TYPES[file.extension.toLowerCase()];
		if (!contentType || file.stat.size > MAX_IMAGE_UPLOAD_BYTES) {
			skipped.push(file.name);
			result += alt || file.name;
			continue;
		}

		if (!uploadsByPath.has(file.path)) {
			const data = await plugin.readBinary(file);
			const upload = await notion.uploadImage(
				plugin.settings,
				file.name,
				contentType,
				data
			);
			uploadsByPath.set(file.path, upload.error ? null : upload.data);
		}

		const fileUploadId = uploadsByPath.get(file.path);
		if (!fileUploadId) {
			skipped.push(file.name);
			result += alt || file.name;
			continue;
		}

		result += `![${alt}](${createFileUploadImageUrl(fileUploadId)})`;
	}

	return { markdown: result + markdown.slice(lastIndex), skipped };
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
	sourceFile: TFile,
	markdown: string
): Promise<string> => {
	// Note embeds (![[Other note]]) become plain links; local images were
	// already handled by uploadLocalImages.
	let updatedMarkdown = markdown.replace(/!\[\[/g, "[[");
	const links = getWikiLinksFromMarkdown(updatedMarkdown);

	for (const link of links) {
		// Only mention notes that were already pushed. Never create vault files
		// or Notion pages for linked notes: they may not be meant for sharing.
		const file = plugin.getLinkedMarkdownFile(
			link.pageName,
			sourceFile.path
		);
		const notionPageId =
			file?.extension === "md"
				? (await plugin.getContent(file)).notionPageId
				: undefined;

		updatedMarkdown = notionPageId
			? replaceWikiWithHyperLink(
					updatedMarkdown,
					link.rawLink,
					link.displayName,
					createNotionPageMentionUrl(notionPageId)
			  )
			: replaceWikiWithText(
					updatedMarkdown,
					link.rawLink,
					link.displayName
			  );
	}

	return updatedMarkdown;
};

