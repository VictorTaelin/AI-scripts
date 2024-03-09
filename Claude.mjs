import fetch from 'node-fetch';
import fs from 'fs/promises';
import path from 'path';

async function getAnthropicKey() {
  const keyPath = path.join(process.env.HOME, '.config', 'anthropic.token');
  return (await fs.readFile(keyPath, 'utf8')).trim();
}

export async function ask({ system, prompt, model = 'claude-3-opus-20240229', temperature = 1, debug = true }) {
  const anthropicKey = await getAnthropicKey();
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': anthropicKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1000,
      temperature,
      stream: debug,
      ...(system && { system }),
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Anthropic API request failed with status ${response.status}: ${errorBody}`);
  }

  if (debug) {
    let result = '';
    for await (const chunk of response.body) {
      const textChunk = new TextDecoder().decode(chunk);
      const lines = textChunk.split('\n');
      for (const line of lines) {
        if (line.startsWith('data:')) {
          try {
            const data = JSON.parse(line.slice(5));
            if (data.type === 'content_block_delta' && data.delta.type === 'text_delta') {
              process.stdout.write(data.delta.text);
              result += data.delta.text;
            }
          } catch (error) {
            // Skip the line if JSON parsing fails
            console.error('Error parsing JSON:', error.message);
          }
        }
      }
    }
    console.log(); // Add a newline at the end
    return result;
  } else {
    const { content } = await response.json();
    return content[0].text;
  }
}
