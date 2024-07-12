import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { OpenAI } from "openai";
import { Anthropic } from '@anthropic-ai/sdk';
import { Groq } from "groq-sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { encode } from "gpt-tokenizer/esm/model/davinci-codex"; // tokenizer

// Map of model shortcodes to full model names
export const MODELS = {
  g: 'gpt-4o',
  G: 'gpt-4-32k-0314',
  h: 'claude-3-haiku-20240307',
  s: 'claude-3-5-sonnet-20240620',
  o: 'claude-3-opus-20240229',
  l: 'llama3-8b-8192',
  L: 'llama3-70b-8192',
  i: 'gemini-1.5-flash-latest',
  I: 'gemini-1.5-pro-latest'
};

// Factory function to create a stateful OpenAI chat
function openAIChat(clientClass) {
  const messages = [];

  async function ask(userMessage, { system, model, temperature = 0.0, max_tokens = 4096, stream = true }) {
    model = MODELS[model] || model;
    const client = new clientClass({ apiKey: await getToken(clientClass.name.toLowerCase()) });

    if (messages.length === 0) {
      messages.push({ role: "system", content: system });
    }

    messages.push({ role: "user", content: userMessage });

    const params = { messages, model, temperature, max_tokens, stream };

    let result = "";
    const response = await client.chat.completions.create(params);

    for await (const chunk of response) {
      const text = chunk.choices[0]?.delta?.content || "";
      process.stdout.write(text);
      result += text;
    }

    messages.push({ role: 'assistant', content: result });

    return result;
  }

  return ask;
}

// Factory function to create a stateful Anthropic chat
function anthropicChat(clientClass) {
  const messages = [];

  async function ask(userMessage, { system, model, temperature = 0.0, max_tokens = 4096, stream = true }) {
    model = MODELS[model] || model;
    const client = new clientClass({ apiKey: await getToken(clientClass.name.toLowerCase()) });

    messages.push({ role: "user", content: userMessage });

    const params = { system, model, temperature, max_tokens, stream };

    let result = "";
    const response = client.messages
      .stream({ ...params, messages })
      .on('text', (text) => {
        process.stdout.write(text);
        result += text;
      });
    await response.finalMessage();

    messages.push({ role: 'assistant', content: result });

    return result;
  }

  return ask;
}

function geminiChat(clientClass) {
  const messages = [];

  async function ask(userMessage, { system, model, temperature = 0.0, max_tokens = 4096, stream = true }) {
    model = MODELS[model] || model;
    const client = new clientClass(await getToken(clientClass.name.toLowerCase()));

    const generationConfig = {
      maxOutputTokens: max_tokens,
      temperature,
    };

    const chat = client.getGenerativeModel({ model, systemInstruction: system, generationConfig })
      .startChat({ history: messages });

    messages.push({ role: "user", parts: [{ text: userMessage }] });

    let result = "";
    if (stream) {
      const response = await chat.sendMessageStream(userMessage);
      for await (const chunk of response.stream) {
        const text = chunk.text();
        process.stdout.write(text);
        result += text;
      }
    } else {
      const response = await chat.sendMessage(userMessage);
      result = (await response.response).text();
    }

    messages.push({ role: 'model', parts: [{ text: result }] });

    return result;
  }

  return ask;
}

// Generic asker function that dispatches to the correct asker based on the model name
export function createChat(model) {
  model = MODELS[model] || model;
  if (model.startsWith('gpt')) {
    return openAIChat(OpenAI);
  } else if (model.startsWith('claude')) {
    return anthropicChat(Anthropic);
  } else if (model.startsWith('llama')) {
    return openAIChat(Groq);
  } else if (model.startsWith('gemini')) {
    return geminiChat(GoogleGenerativeAI);
  } else {
    throw new Error(`Unsupported model: ${model}`);
  }
}

// Utility function to read the API token for a given vendor
async function getToken(vendor) {
  const tokenPath = path.join(os.homedir(), '.config', `${vendor}.token`);
  try {
    return (await fs.readFile(tokenPath, 'utf8')).trim();
  } catch (err) {
    console.error(`Error reading ${vendor}.token file:`, err.message);
    process.exit(1);
  }
}

export function tokenCount(inputText) {
  // Encode the input string into tokens
  const tokens = encode(inputText);

  // Get the number of tokens
  const numberOfTokens = tokens.length;

  // Return the number of tokens
  return numberOfTokens;
}
