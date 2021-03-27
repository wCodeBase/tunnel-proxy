module.exports = {
    root: true,
    parser: '@typescript-eslint/parser',
    plugins: ['prettier', 'typescript', '@typescript-eslint'],
    extends: [
        'eslint:recommended',
        'plugin:@typescript-eslint/eslint-recommended',
        'plugin:@typescript-eslint/recommended',
    ],
    env: {
        node: true,
    },
    rules: {
        'prettier/prettier': 'error',
        '@typescript-eslint/no-var-requires': 'off',
        '@typescript-eslint/ban-ts-comment': 'off',
        '@typescript-eslint/explicit-module-boundary-types': 'off',
        'no-async-promise-executor': 'off',
    },
};
