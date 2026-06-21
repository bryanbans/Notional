import obsidianmd from "eslint-plugin-obsidianmd";
import tseslint from "typescript-eslint";

export default [
	{
		files: ["**/*.ts"],
		ignores: ["main.js", "node_modules/**", "tests/**"],
		languageOptions: {
			parser: tseslint.parser,
			parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
		},
		plugins: { obsidianmd, "@typescript-eslint": tseslint.plugin },
		rules: {
			"@typescript-eslint/no-floating-promises": "error",
			"obsidianmd/no-unsupported-api": "error",
			"obsidianmd/settings-tab/no-manual-html-headings": "error",
			"obsidianmd/settings-tab/no-problematic-settings-headings": "warn",
			"obsidianmd/prefer-window-timers": "warn",
			"obsidianmd/prefer-get-language": "warn",
			"obsidianmd/detach-leaves": "warn",
			"obsidianmd/no-static-styles-assignment": "warn",
			"obsidianmd/validate-manifest": "warn",
		},
	},
];
