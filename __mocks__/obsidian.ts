export class TFile {
	basename: string;
	name: string;
	path: string;
	extension: string;
	parent: TFolder | null = null;
	stat = {
		mtime: 0,
		size: 0,
	};
}

export class Notice {
	constructor(public message: string, public timeout?: number) {}
}

export class TFolder {
	children: Array<TFile | TFolder> = [];
	isRoot = jest.fn().mockReturnValue(false);
}

export class App {}
export class PluginManifest {}

export const requestUrl = jest.fn();

export default {
	requestUrl,
};
