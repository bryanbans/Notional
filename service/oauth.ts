import { requestUrl } from "obsidian";
import {
	NotionOAuthTokenResponse,
	PluginSettings,
	ServiceResult,
} from "./types";

export const NOTION_OAUTH_AUTHORIZE_URL =
	"https://api.notion.com/v1/oauth/authorize";

// Notion's token endpoint requires the client to authenticate with its secret
// (HTTP Basic). In the default "bring your own integration" flow the user's own
// client secret lives only in their local vault, so the exchange happens
// directly device-to-Notion with no developer-operated server in between.
export const NOTION_OAUTH_TOKEN_URL = "https://api.notion.com/v1/oauth/token";

const errorResult = <T>(error: Error, data: unknown = null): ServiceResult<T> => ({
	data: data as T,
	error,
});

// Prefer a token obtained through OAuth, falling back to a manually pasted
// internal-integration secret. Both are bearer tokens to Notion.
export const resolveNotionToken = (settings: PluginSettings): string =>
	settings.notionOAuthAccessToken || settings.notionAPIToken;

// Whether the user has any usable Notion bearer token. Gating in main.ts and
// the sync panel must resolve the token the same way the API layer does, or an
// OAuth-only user (no manual token) is wrongly treated as unauthenticated.
export const hasNotionToken = (settings: PluginSettings): boolean =>
	resolveNotionToken(settings).length > 0;

// Full credentials for *uploading*: a token plus a destination database. Pull
// and Sync of an already-linked note only need a token (see hasNotionToken).
export const hasNotionCredentials = (settings: PluginSettings): boolean =>
	hasNotionToken(settings) && settings.databaseID.length > 0;

// CSRF guard for the OAuth redirect: the echoed state must be present and match
// the value generated when the flow started. A missing state is rejected so a
// forged callback cannot bypass the check simply by omitting it.
export const isMatchingOAuthState = (
	pendingState: string | null,
	incomingState?: string | null
): boolean =>
	Boolean(pendingState) &&
	Boolean(incomingState) &&
	incomingState === pendingState;

const BASE64URL_REPLACEMENTS: Record<string, string> = {
	"+": "-",
	"/": "_",
	"=": "",
};

const base64UrlEncode = (bytes: Uint8Array): string => {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/[+/=]/g, (match) => BASE64URL_REPLACEMENTS[match]);
};

// Opaque value echoed back via the redirect; guards against CSRF and stray
// callbacks landing on the wrong in-flight request.
export const generateOAuthState = (): string => {
	const randomBytes = new Uint8Array(16);
	crypto.getRandomValues(randomBytes);
	return base64UrlEncode(randomBytes);
};

export type BuildOAuthUrlOptions = {
	clientId: string;
	redirectUri: string;
	state?: string;
};

export const buildNotionOAuthUrl = (options: BuildOAuthUrlOptions): string => {
	const url = new URL(NOTION_OAUTH_AUTHORIZE_URL);
	url.searchParams.set("owner", "user");
	url.searchParams.set("client_id", options.clientId);
	url.searchParams.set("redirect_uri", options.redirectUri);
	url.searchParams.set("response_type", "code");
	if (options.state) url.searchParams.set("state", options.state);
	return url.toString();
};

export const extractNotionOAuthCode = (input: string): string | null => {
	const trimmed = input.trim();
	if (!trimmed) return null;

	try {
		const url = new URL(trimmed);
		return url.searchParams.get("code");
	} catch {
		return trimmed;
	}
};

const parseTokenResponse = (
	json: unknown,
	status: number
): ServiceResult<NotionOAuthTokenResponse> => {
	if (status >= 400) {
		const body = json as {
			error?: string;
			error_description?: string;
			message?: string;
		} | null;
		return errorResult(
			Error(
				body?.error_description ||
					body?.message ||
					body?.error ||
					`OAuth exchange failed with status ${status}`
			),
			json
		);
	}

	const data = json as Partial<NotionOAuthTokenResponse> | null;
	if (!data?.access_token) {
		return errorResult(
			Error("OAuth exchange did not return an access token."),
			json
		);
	}

	return {
		data: {
			access_token: data.access_token,
			refresh_token: data.refresh_token ?? null,
			workspace_id: data.workspace_id ?? null,
			workspace_name: data.workspace_name ?? null,
			duplicated_template_id: data.duplicated_template_id ?? null,
		},
		error: null,
	};
};

// Completes the authorization-code exchange. Default path: the user's own
// client secret authenticates the request directly to Notion (nothing leaves
// the device except to Notion). Fallback: post to a user-configured hosted
// endpoint that holds the secret server-side.
export const completeNotionOAuth = async (
	settings: PluginSettings,
	codeOrCallbackUrl: string
): Promise<ServiceResult<NotionOAuthTokenResponse>> => {
	const code = extractNotionOAuthCode(codeOrCallbackUrl);
	if (!code) {
		return errorResult(Error("Paste the Notion callback URL or code."));
	}

	const endpoint = settings.notionOAuthTokenExchangeUrl.trim();
	if (endpoint) {
		return exchangeViaHostedEndpoint(settings, endpoint, code);
	}

	if (!settings.notionOAuthClientId || !settings.notionOAuthClientSecret) {
		return errorResult(
			Error(
				"Set the OAuth client ID and client secret (or a token exchange endpoint) before connecting."
			)
		);
	}

	return exchangeViaClientSecret(settings, code);
};

const exchangeViaClientSecret = async (
	settings: PluginSettings,
	code: string
): Promise<ServiceResult<NotionOAuthTokenResponse>> => {
	const basic = btoa(
		`${settings.notionOAuthClientId}:${settings.notionOAuthClientSecret}`
	);

	try {
		const response = await requestUrl({
			url: NOTION_OAUTH_TOKEN_URL,
			method: "POST",
			throw: false,
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
				Authorization: `Basic ${basic}`,
			},
			body: JSON.stringify({
				grant_type: "authorization_code",
				code,
				redirect_uri: settings.notionOAuthRedirectUri,
			}),
		});

		return parseTokenResponse(response.json, response.status);
	} catch (error) {
		return errorResult(
			Error(`Could not complete OAuth exchange: ${error}`)
		);
	}
};

const exchangeViaHostedEndpoint = async (
	settings: PluginSettings,
	endpoint: string,
	code: string
): Promise<ServiceResult<NotionOAuthTokenResponse>> => {
	try {
		const response = await requestUrl({
			url: endpoint,
			method: "POST",
			throw: false,
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify({
				code,
				redirect_uri: settings.notionOAuthRedirectUri,
			}),
		});

		return parseTokenResponse(response.json, response.status);
	} catch (error) {
		return errorResult(
			Error(`Could not complete OAuth exchange: ${error}`)
		);
	}
};
