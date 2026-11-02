import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ESLint} from '../../controller/tenant-compute/node_modules/eslint/lib/api.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../controller/tenant-compute');
const checker = new ESLint({cwd: root, overrideConfigFile: true, overrideConfig: [{
  files: ['**/*.mjs'],
  languageOptions: {ecmaVersion: 'latest', sourceType: 'module',
    globals: Object.fromEntries(Object.getOwnPropertyNames(globalThis).map(name => [name, 'readonly']))},
  rules: {
    'no-undef': 'error',
    'no-unused-vars': ['error', {args: 'none', caughtErrors: 'none'}],
    complexity: ['error', 15],
    'max-depth': ['error', 3],
    'max-params': ['error', 6],
    'no-nested-ternary': 'error'
  }
}]});
const results = await checker.lintFiles(['**/*.mjs']);
const formatter = await checker.loadFormatter('stylish');
process.stdout.write(formatter.format(results));
if (results.some(result => result.errorCount || result.warningCount)) process.exitCode = 1;
