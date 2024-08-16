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
  g: 'gpt-4o-2024-08-06',
  //g: 'chatgpt-4o-latest', 
  G: 'gpt-4-32k-0314',
  h: 'claude-3-haiku-20240307',
  s: 'claude-3-5-sonnet-20240620',
  o: 'claude-3-opus-20240229',
  l: 'llama-3.1-8b-instant',
  L: 'llama-3.1-70b-versatile',
  i: 'gemini-1.5-flash-latest',
  //I: 'gemini-1.5-pro-latest'
  I: 'gemini-1.5-pro-exp-0801'
  // openrouter models are not included here
};

// Factory function to create a stateful OpenAI chat
export function openAIChat(clientClass) {
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
export function anthropicChat(clientClass) {
  const messages = [];

  async function ask(userMessage, { system, model, temperature = 0.0, max_tokens = 4096, stream = true, system_cacheable = false }) {
    model = MODELS[model] || model;
    const client = new clientClass({ 
      apiKey: await getToken(clientClass.name.toLowerCase()),
      defaultHeaders: {
        "anthropic-beta": "prompt-caching-2024-07-31" // Enable prompt caching
      }
    });

    let params = { model, temperature, max_tokens, stream, messages };
    
    const cached_system_message = { type: "text", text: system, cache_control: { type: "ephemeral" } };

    let message = {
      role: "user",
      content: [
        {
          type: "text",
          text: userMessage,
        }
      ]
    }

    if (system_cacheable) {
      message.content.unshift(cached_system_message);
    } else {
      params = { ...params, system };
    }

    messages.push(message);

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

export function geminiChat(clientClass) {
  const messages = [];

  async function ask(userMessage, { system, model, temperature = 0.0, max_tokens = 4096, stream = true }) {
    model = MODELS[model] || model;
    const client = new clientClass(await getToken(clientClass.name.toLowerCase()));

    const generationConfig = {
      maxOutputTokens: max_tokens,
      temperature,
    };

    const safetySettings = [
      {
        category: "HARM_CATEGORY_HARASSMENT",
        threshold: "BLOCK_NONE",
      },
      {
        category: "HARM_CATEGORY_HATE_SPEECH",
        threshold: "BLOCK_NONE",
      },
      {
        category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
        threshold: "BLOCK_NONE",
      },
      {
        category: "HARM_CATEGORY_DANGEROUS_CONTENT",
        threshold: "BLOCK_NONE",
      },
    ];

    const chat = client.getGenerativeModel({ model, generationConfig })
      .startChat({
        history: messages,
        safetySettings: safetySettings,
      });

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

// Factory function to create a stateful Openrouter chat
export function openRouterChat(clientClass) {
  const messages = [];

  async function ask(userMessage, { system, model, temperature = 0.0, max_tokens = 4096, stream = true }) {

    [, model] = model.split(':');
    const client = new clientClass({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: await getToken('openrouter'),
    });

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

// Generic asker function that dispatches to the correct asker based on the model name
export function chat(model) {
  model = MODELS[model] || model;
  if (model.startsWith('gpt')) {
    return openAIChat(OpenAI);
  } else if (model.startsWith('chatgpt')) {
    return openAIChat(OpenAI);
  } else if (model.startsWith('claude')) {
    return anthropicChat(Anthropic);
  } else if (model.startsWith('llama')) {
    return openAIChat(Groq);
  } else if (model.startsWith('gemini')) {
    return geminiChat(GoogleGenerativeAI);
  } else if (model.startsWith('openrouter:')) {
    return openRouterChat(OpenAI);
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
