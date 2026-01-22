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

const binFiles = ['Refactor.js', 'HoleFill.js', 'ChatSH.js'];
for (const file of binFiles) {
  try {
    if (existsSync(`./dist/${file}`)) {
      chmodSync(`./dist/${file}`, 0o755);
      console.log(`Marked dist/${file} as executable`);
    }
  } catch (err) {
    console.warn(`Failed to adjust dist/${file} permissions:`, err);
  }
}
