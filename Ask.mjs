import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { OpenAI } from "openai";
import { Anthropic } from '@anthropic-ai/sdk';
import { Groq } from "groq-sdk";
import { encode } from "gpt-tokenizer/esm/model/davinci-codex"; // tokenizer

// Map of model shortcodes to full model names
export const MODELS = {
  g: 'gpt-4-turbo-2024-04-09', 
  G: 'gpt-4-32k-0314',
  h: 'claude-3-haiku-20240307',
  s: 'claude-3-sonnet-20240229',
  o: 'claude-3-opus-20240229',
  l: 'llama3-8b-8192',
  L: 'llama3-70b-8192'
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

// Utility function to read the Groq API token
async function getGroqToken() {
  const tokenPath = path.join(os.homedir(), '.config', 'groq.token');
  try {
    return (await fs.readFile(tokenPath, 'utf8')).trim();
  } catch (err) {
    console.error('Error reading groq.token file:', err.message);
    process.exit(1);
  }
}

// Factory function to create a stateful asker
export function asker() {
  const messages = [];

  // Asker function that maintains conversation state
  async function ask(userMessage, { system, model, temperature = 0.0, max_tokens = 4096 }) {
    model = MODELS[model] || model;
    const isOpenAI = model.startsWith('gpt');
    const isAnthropic = model.startsWith('claude'); 
    const isGroq = model.startsWith('llama');

    let client;
    if (isOpenAI) {
      client = new OpenAI({ apiKey: await getOpenAIToken() });
    } else if (isAnthropic) {
      client = new Anthropic({ apiKey: await getAnthropicToken() });
    } else if (isGroq) {
      client = new Groq({ apiKey: await getGroqToken() });
    } else {
      throw new Error(`Unsupported model: ${model}`);
    }

    if (messages.length === 0 && !isAnthropic) {
      messages.push({ role: "system", content: system });
    }

    messages.push({ role: "user", content: userMessage });

    const params = {
      system: isAnthropic ? system : undefined,
      model,
      temperature,
      max_tokens,
      stream: true,
    };

    let result = "";

    if (isOpenAI) {
      params.messages = messages;

      const stream = await client.chat.completions.create(params);

      for await (const chunk of stream) {
        const text = chunk.choices[0]?.delta?.content || "";
        process.stdout.write(text);
        result += text;
      }
    } else if (isAnthropic) {
      const stream = client.messages.stream({
        ...params,
        messages
      }).on('text', (text) => {
        process.stdout.write(text);
        result += text;  
      });
      await stream.finalMessage();
    } else if (isGroq) {
      params.messages = messages.map(msg => ({
        role: msg.role,
        content: msg.content
      }));

      const stream = await client.chat.completions.create(params);

      for await (const chunk of stream) {
        const text = chunk.choices[0]?.delta?.content || "";
        process.stdout.write(text);
        result += text;
      }
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
