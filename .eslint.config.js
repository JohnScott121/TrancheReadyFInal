export default [
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
    plugins: { import: await import('eslint-plugin-import') },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'off',
      'import/order': ['warn', { 'newlines-between': 'always' }]
    },
    ignores: ['node_modules/**', 'public/**', 'docs/**']
  }
];
