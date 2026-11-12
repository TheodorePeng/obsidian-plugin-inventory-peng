// @ts-check
import tseslint from 'typescript-eslint';

// The community ruleset is opt-in by installation: once
// `eslint-plugin-obsidianmd` is present it is loaded and applied, and until
// then this config behaves exactly as it did before. That keeps `npm run lint`
// working in the meantime instead of failing on a missing module.
let obsidianmd = null;
try {
  obsidianmd = (await import('eslint-plugin-obsidianmd')).default;
} catch {
  console.warn(
    '[eslint] eslint-plugin-obsidianmd is not installed — community rules are off.\n' +
      '          Enable them with: npm i -D eslint-plugin-obsidianmd@^0.5.1',
  );
}

export default tseslint.config(
  // ── Ignored paths ────────────────────────────────────────────────────────
  {
    ignores: [
      'node_modules/**',
      'main.js',          // esbuild bundle output
      'dist/**',
      'coverage/**',
    ],
  },

  // ── TypeScript parser and recommended rules ──────────────────────────────
  // Applied globally: without the parser, ESLint would try to read `src/**`
  // as plain JavaScript and fail with "Parsing error".
  ...tseslint.configs.recommended,

  // ── Obsidian community ruleset ───────────────────────────────────────────
  // Same ruleset the Obsidian automated reviewer runs. Applied only once the
  // package is installed; see the note above.
  ...(obsidianmd ? obsidianmd.configs.recommended : []),

  // ── Type information ──────────────────────────────────────────────────────
  // Some community rules (await-thenable and friends) require type information.
  // `tsconfig.eslint.json` is a standalone project — no `extends` — because
  // typescript-eslint's parser rejects the project's "moduleResolution": "Bundler".
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // ── Obsidian's `any`-heavy API surface ───────────────────────────────────
  // Obsidian types several callbacks and settings as `any` (processFrontMatter
  // callbacks, plugin settings, manifest reads). Reporting every access as an
  // error buries the real findings, so these stay visible as warnings — the
  // same trade-off obsidian-attachments-library-peng already makes.
  {
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
    },
  },

  // ── Source files ─────────────────────────────────────────────────────────
  {
    files: ['src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },

  // ── Test files: relaxed rules ────────────────────────────────────────────
  {
    files: ['tests/**/*.ts', '__mocks__/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
      '@typescript-eslint/no-floating-promises': 'off',
      'prefer-const': 'error',
    },
  },
);
