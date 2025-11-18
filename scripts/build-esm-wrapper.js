#!/usr/bin/env node
const { writeFileSync, chmodSync, existsSync } = require('fs');

const esmWrapper = `// ES Module wrapper for tai-scripts
import pkg from './index.js';
const { GenAI, MODELS, tokenCount } = pkg;

export { GenAI, MODELS, tokenCount };
export default pkg;
`;

writeFileSync('./dist/index.mjs', esmWrapper);
console.log('Created ES module wrapper at dist/index.mjs');

try {
  if (existsSync('./dist/refactor.js')) {
    chmodSync('./dist/refactor.js', 0o755);
    console.log('Marked dist/refactor.js as executable');
  }
} catch (err) {
  console.warn('Failed to adjust dist/refactor.js permissions:', err);
}
