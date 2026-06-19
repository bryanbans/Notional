export class TFile {
	basename: string;
	stat = {
		mtime: 0,
	};
}

export class App {}
export class PluginManifest {}

export const requestUrl = jest.fn();

export default {
	requestUrl,
};
