// LLD §0.1: a module may import another module only through that module's index.ts.
import tseslint from 'typescript-eslint';

export default tseslint.config(...tseslint.configs.recommended, {
  files: ['src/**/*.ts'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            // ../mNN_x/anything-but-index  (sibling module internals)
            regex: '^\\.\\./m\\d{2}_[a-z0-9_]+/(?!index(\\.js)?$).+',
            message: 'Import other modules only through their index.ts (LLD §0.1).',
          },
          {
            regex: '(^|/)modules/m\\d{2}_[a-z0-9_]+/(?!index(\\.js)?$).+',
            message: 'Import other modules only through their index.ts (LLD §0.1).',
          },
        ],
      },
    ],
  },
});
