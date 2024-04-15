import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { OpenAI } from "openai";
import { Anthropic } from '@anthropic-ai/sdk';
import { encode } from "gpt-tokenizer/esm/model/davinci-codex"; // tokenizer

// Map of model shortcodes to full model names
export const MODELS = {
  g: 'gpt-4-turbo-2024-04-09', 
  G: 'gpt-4-32k-0314',
  c: 'claude-3-haiku-20240307',
  s: 'claude-3-sonnet-20240229',
  C: 'claude-3-opus-20240229',
};

// Utility function to read the OpenAI API token
async function getOpenAIToken() {
  const tokenPath = path.join(os.homedir(), '.config', 'openai.token');
  try {
    return (await fs.readFile(tokenPath, 'utf8')).trim();
  } catch (err) {
    console.error('Error reading openai.token file:', err.message);
    process.exit(1);
  }
}

// Utility function to read the Anthropic API token
async function getAnthropicToken() {
  const tokenPath = path.join(os.homedir(), '.config', 'anthropic.token');
  try {
    return (await fs.readFile(tokenPath, 'utf8')).trim();
  } catch (err) {
    console.error('Error reading anthropic.token file:', err.message);
    process.exit(1);
  }  
}

// Factory function to create a stateful asker
export function asker() {
  const messages = [];

  // Asker function that maintains conversation state
  async function ask(userMessage, { model, temperature = 0.0, max_tokens = 4096 }) {
    model = MODELS[model] || model;
    const isGPT = model.startsWith('gpt');
    
    const client = isGPT ?
      new OpenAI({ apiKey: await getOpenAIToken() }) :
      new Anthropic({ apiKey: await getAnthropicToken() });
    
    messages.push({ role: 'user', content: userMessage });

    const params = {
      model,
      temperature, 
      max_tokens,
      stream: true,
    };
    
    let result = "";

    if (isGPT) {
      params.messages = messages;
      
      const stream = await client.chat.completions.create(params);
      
      for await (const chunk of stream) {
        const text = chunk.choices[0]?.delta?.content || "";
        process.stdout.write(text);
        result += text;
      }
    } else {
      const stream = client.messages.stream({
        ...params,
        messages
      }).on('text', (text) => {
        process.stdout.write(text);
        result += text;
      });
      await stream.finalMessage();
    }

    messages.push({ role: 'assistant', content: result });

    return result;
  }

  return ask;
}

export function token_count(inputText) {
  // Encode the input string into tokens
  const tokens = encode(inputText);

  // Get the number of tokens
  const numberOfTokens = tokens.length;

  // Return the number of tokens
  return numberOfTokens;
}

