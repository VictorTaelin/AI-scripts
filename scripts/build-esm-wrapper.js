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
  if (existsSync('./dist/holefill2.js')) {
    chmodSync('./dist/holefill2.js', 0o755);
    console.log('Marked dist/holefill2.js as executable');
  }
} catch (err) {
  console.warn('Failed to adjust dist/holefill2.js permissions:', err);
}
