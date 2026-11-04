import js from '@eslint/js';
import ts from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';

export default ts.config(
	js.configs.recommended,
	...ts.configs.recommended,
	...svelte.configs['flat/recommended'],
	{
		languageOptions: {
			globals: { ...globals.browser, ...globals.node }
		},
		rules: {
			'@typescript-eslint/no-unused-vars': [
				'error',
				{ argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
			],
			'@typescript-eslint/no-explicit-any': 'warn',
			'no-empty': ['error', { allowEmptyCatch: true }],
			// This rule expects SvelteKit 3's `resolve()` from `$app/paths`. The project is
			// on SvelteKit 2 with no base path, where plain internal paths are correct.
			// Re-enable when upgrading to Kit 3 (see docs/ARCHITECTURE.md).
			'svelte/no-navigation-without-resolve': 'off'
		}
	},
	{
		files: ['**/*.svelte', '**/*.svelte.ts'],
		languageOptions: { parserOptions: { parser: ts.parser } }
	},
	{
		ignores: [
			'node_modules/**',
			'.svelte-kit/**',
			'build/**',
			'.devdb/**',
			'test-results/**',
			'playwright-report/**'
		]
	}
);
