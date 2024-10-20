export default function kind_clean(fileContent) {
  const lines = fileContent.split('\n');
  const testIndex = lines.findIndex(line => line.trim().startsWith('TEST_'));
  
  if (testIndex === -1) {
    return fileContent.trim();
  }

  // Remove all contents from the first TEST_ line and after
  const newLines = lines.slice(0, testIndex);

  // Remove trailing lines that start with //
  while (newLines.length > 0 && newLines[newLines.length - 1].trim().startsWith('//')) {
    newLines.pop();
  }

  return newLines.join('\n').trim();
}
