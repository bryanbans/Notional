jest.mock("obsidian");

import { requestUrl } from "obsidian";
import {
	NOTION_OAUTH_TOKEN_URL,
	buildNotionOAuthUrl,
	completeNotionOAuth,
	extractNotionOAuthCode,
	generateOAuthState,
	hasNotionCredentials,
	hasNotionToken,
	isMatchingOAuthState,
	resolveNotionToken,
} from "../service/oauth";
import { PluginSettings } from "../service/types";

const settings: PluginSettings = {
	notionAPIToken: "",
	notionOAuthClientId: "client-id",
	notionOAuthClientSecret: "client-secret",
	notionOAuthRedirectUri: "https://example.com/notion/callback",
	notionOAuthTokenExchangeUrl: "",
	notionOAuthAccessToken: "",
	notionOAuthWorkspaceId: "",
	notionOAuthWorkspaceName: "",
	notionOAuthRefreshToken: "",
	databaseID: "",
	notionParentPageUrl: "",
	bannerUrl: "",
	notionWorkspaceID: "",
	allowTags: false,
	autoSync: false,
	autoSyncIntervalMinutes: 5,
};

beforeEach(() => {
	jest.clearAllMocks();
});

describe("buildNotionOAuthUrl", () => {
	it("builds Notion's authorization URL with state", () => {
		const url = new URL(
			buildNotionOAuthUrl({
				clientId: "client-id",
				redirectUri: "https://example.com/notion/callback",
				state: "state-value",
			})
		);

		expect(url.origin + url.pathname).toBe(
			"https://api.notion.com/v1/oauth/authorize"
		);
		expect(url.searchParams.get("owner")).toBe("user");
		expect(url.searchParams.get("client_id")).toBe("client-id");
		expect(url.searchParams.get("redirect_uri")).toBe(
			"https://example.com/notion/callback"
		);
		expect(url.searchParams.get("response_type")).toBe("code");
		expect(url.searchParams.get("state")).toBe("state-value");
	});

	it("omits state when none is supplied", () => {
		const url = new URL(
			buildNotionOAuthUrl({
				clientId: "client-id",
				redirectUri: "https://example.com/notion/callback",
			})
		);
		expect(url.searchParams.has("state")).toBe(false);
	});
});

describe("generateOAuthState", () => {
	it("produces a url-safe random value", () => {
		expect(generateOAuthState()).toMatch(/^[A-Za-z0-9\-_]+$/);
		expect(generateOAuthState()).not.toBe(generateOAuthState());
	});
});

describe("extractNotionOAuthCode", () => {
	it("extracts a code from a callback URL", () => {
		expect(
			extractNotionOAuthCode(
				"https://example.com/notion/callback?code=abc123&state=ignored"
			)
		).toBe("abc123");
	});

	it("accepts a bare code", () => {
		expect(extractNotionOAuthCode("abc123")).toBe("abc123");
	});
});

describe("resolveNotionToken", () => {
	it("prefers the OAuth access token", () => {
		expect(
			resolveNotionToken({
				...settings,
				notionOAuthAccessToken: "oauth-token",
				notionAPIToken: "manual-token",
			})
		).toBe("oauth-token");
	});

	it("falls back to the manual API token", () => {
		expect(
			resolveNotionToken({
				...settings,
				notionOAuthAccessToken: "",
				notionAPIToken: "manual-token",
			})
		).toBe("manual-token");
	});
});

describe("hasNotionToken / hasNotionCredentials", () => {
	it("treats an OAuth-only connection as authenticated", () => {
		const oauthOnly = {
			...settings,
			notionAPIToken: "",
			notionOAuthAccessToken: "oauth-access-token",
			databaseID: "db-id",
		};
		expect(hasNotionToken(oauthOnly)).toBe(true);
		expect(hasNotionCredentials(oauthOnly)).toBe(true);
	});

	it("treats a pasted integration secret as authenticated", () => {
		const manual = {
			...settings,
			notionAPIToken: "secret",
			notionOAuthAccessToken: "",
			databaseID: "db-id",
		};
		expect(hasNotionToken(manual)).toBe(true);
		expect(hasNotionCredentials(manual)).toBe(true);
	});

	it("is unauthenticated when neither token is set", () => {
		const none = {
			...settings,
			notionAPIToken: "",
			notionOAuthAccessToken: "",
		};
		expect(hasNotionToken(none)).toBe(false);
		expect(hasNotionCredentials(none)).toBe(false);
	});

	it("requires a database for full credentials but not for a bare token", () => {
		const noDb = {
			...settings,
			notionAPIToken: "",
			notionOAuthAccessToken: "oauth-access-token",
			databaseID: "",
		};
		expect(hasNotionToken(noDb)).toBe(true);
		expect(hasNotionCredentials(noDb)).toBe(false);
	});
});

describe("isMatchingOAuthState", () => {
	it("accepts an exact match", () => {
		expect(isMatchingOAuthState("state-123", "state-123")).toBe(true);
	});

	it("rejects a mismatched state", () => {
		expect(isMatchingOAuthState("state-123", "tampered")).toBe(false);
	});

	it("rejects a missing incoming state", () => {
		expect(isMatchingOAuthState("state-123", undefined)).toBe(false);
		expect(isMatchingOAuthState("state-123", "")).toBe(false);
	});

	it("rejects when nothing is pending", () => {
		expect(isMatchingOAuthState(null, "state-123")).toBe(false);
	});
});

describe("completeNotionOAuth", () => {
	it("exchanges directly with Notion using HTTP Basic auth", async () => {
		(requestUrl as jest.Mock).mockResolvedValueOnce({
			status: 200,
			json: {
				access_token: "oauth-token",
				refresh_token: "refresh-token",
				workspace_id: "workspace-id",
				workspace_name: "Workspace",
			},
		});

		const result = await completeNotionOAuth(
			settings,
			"https://example.com/notion/callback?code=abc123"
		);

		const expectedBasic = btoa("client-id:client-secret");
		expect(requestUrl).toHaveBeenCalledWith(
			expect.objectContaining({
				url: NOTION_OAUTH_TOKEN_URL,
				method: "POST",
				headers: expect.objectContaining({
					Authorization: `Basic ${expectedBasic}`,
				}),
				body: JSON.stringify({
					grant_type: "authorization_code",
					code: "abc123",
					redirect_uri: settings.notionOAuthRedirectUri,
				}),
			})
		);
		expect(result.error).toBeNull();
		expect(result.data.access_token).toBe("oauth-token");
		expect(result.data.workspace_name).toBe("Workspace");
	});

	it("routes through a hosted endpoint when one is configured", async () => {
		(requestUrl as jest.Mock).mockResolvedValueOnce({
			status: 200,
			json: { access_token: "hosted-token" },
		});

		const result = await completeNotionOAuth(
			{
				...settings,
				notionOAuthTokenExchangeUrl:
					"https://example.com/api/notion/oauth/token",
			},
			"abc123"
		);

		expect(requestUrl).toHaveBeenCalledWith(
			expect.objectContaining({
				url: "https://example.com/api/notion/oauth/token",
				method: "POST",
				body: JSON.stringify({
					code: "abc123",
					redirect_uri: settings.notionOAuthRedirectUri,
				}),
			})
		);
		// No client secret is sent to the hosted endpoint; it holds its own.
		const call = (requestUrl as jest.Mock).mock.calls[0][0];
		expect(call.headers.Authorization).toBeUndefined();
		expect(result.error).toBeNull();
		expect(result.data.access_token).toBe("hosted-token");
	});

	it("requires a code", async () => {
		const result = await completeNotionOAuth(settings, "   ");
		expect(result.error?.message).toContain("callback URL or code");
		expect(requestUrl).not.toHaveBeenCalled();
	});

	it("requires a client secret when exchanging directly", async () => {
		const result = await completeNotionOAuth(
			{ ...settings, notionOAuthClientSecret: "" },
			"abc123"
		);
		expect(result.error?.message).toContain("client secret");
		expect(requestUrl).not.toHaveBeenCalled();
	});

	it("surfaces an error status from Notion", async () => {
		(requestUrl as jest.Mock).mockResolvedValueOnce({
			status: 401,
			json: { error: "invalid_client" },
		});

		const result = await completeNotionOAuth(settings, "abc123");
		expect(result.error?.message).toContain("invalid_client");
	});
});
