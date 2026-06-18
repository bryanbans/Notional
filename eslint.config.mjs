import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
	{
		ignores: ["main.js", "node_modules/**"],
	},
	eslint.configs.recommended,
	...tseslint.configs.recommended,
	{
		files: ["**/*.js", "**/*.cjs"],
		languageOptions: {
			sourceType: "commonjs",
			globals: {
				module: "readonly",
				require: "readonly",
				__dirname: "readonly",
				process: "readonly",
			},
		},
	},
	{
		languageOptions: {
			globals: {
				window: "readonly",
				document: "readonly",
				localStorage: "readonly",
				console: "readonly",
				process: "readonly",
			},
		},
		rules: {
			"@typescript-eslint/no-unused-vars": ["error", { args: "none" }],
			"@typescript-eslint/ban-ts-comment": "off",
			"@typescript-eslint/no-empty-function": "off",
			"@typescript-eslint/no-explicit-any": "off",
			"no-prototype-builtins": "off",
		},
	}
);
