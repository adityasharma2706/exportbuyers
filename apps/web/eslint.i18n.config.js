// M04 — "every string comes from t(key)" (REQ-058, LLD M04).
// Spread this into apps/web/eslint.config.js: `export default tseslint.config(..., ...i18nLint)`.
// The i18next/no-literal-string rule fails the build on literal JSX text. M04's own components use
// createElement (the typecheck has no JSX setting yet) and are covered by findLiteralChildren in
// src/modules/m04_ui/lint/literalText.ts, exercised by src/modules/m04_ui/ui.test.ts.
import i18next from 'eslint-plugin-i18next';

export default [
  {
    files: ['src/**/*.tsx', 'src/**/*.jsx'],
    plugins: { i18next },
    rules: {
      'i18next/no-literal-string': ['error', { mode: 'jsx-text-only' }],
    },
  },
];
