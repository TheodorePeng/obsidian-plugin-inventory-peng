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

  // ── Obsidian community ruleset ───────────────────────────────────────────
  // Same ruleset the Obsidian automated reviewer runs. Applied only once the
  // package is installed; see the note above.
  ...(obsidianmd ? obsidianmd.configs.recommended : []),

  // ── Type information ──────────────────────────────────────────────────────
  // The Obsidian community ruleset enables type-aware rules such as
  // await-thenable, so every linted TypeScript file needs parserOptions.project.
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
  // Keep unsafe-* findings visible as warnings rather than release blockers.
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
    extends: [
      ...tseslint.configs.recommended,
    ],
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
