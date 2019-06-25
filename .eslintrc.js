module.exports = {
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  extends: [
    'plugin:@typescript-eslint/recommended',
    'prettier',
    'prettier/@typescript-eslint'
  ],
  parserOptions: {
    ecmaVersion: 2018,
    sourceType: 'module'
  },
  rules: {
    'dot-notation': 'error',
    eqeqeq: 'error',
    'no-loop-func': 'error',
    'no-mixed-spaces-and-tabs': 'error',
    'no-throw-literal': 'error',
    'prefer-const': 'error',
    '@typescript-eslint/camelcase': ['error', {properties: 'never'}],
    '@typescript-eslint/no-use-before-define': 'off',
    '@typescript-eslint/no-var-requires': 'off',
    '@typescript-eslint/explicit-function-return-type': 'off' // this is temporary until https://github.com/typescript-eslint/typescript-eslint/issues/149 is resolved
  }
}
