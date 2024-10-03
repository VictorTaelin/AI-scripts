import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { OpenAI } from "openai";
import { Anthropic } from '@anthropic-ai/sdk';
import { OpenRouter } from "@openrouter/ai-sdk-provider";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { encode } from "gpt-tokenizer/esm/model/davinci-codex"; // tokenizer

// Map of model shortcodes to full model names
export const MODELS = {
  // GPT by OpenAI
  gm: 'gpt-4o-mini',
  g: 'gpt-4o-2024-08-06',
  G: 'gpt-4-32k-0314',

  // o1 by OpenAI
  om: 'o1-mini',
  o: 'o1-preview',

  // Claude by Anthropic
  cm: 'claude-3-haiku-20240307',
  c: 'claude-3-5-sonnet-20240620',
  C: 'claude-3-opus-20240229',

  // Llama by Meta
  lm: 'meta-llama/llama-3.1-8b-instruct',
  l: 'meta-llama/llama-3.1-70b-instruct',
  L: 'meta-llama/llama-3.1-405b-instruct',

  // Gemini by Google
  i: 'gemini-1.5-flash-latest',
  I: 'gemini-1.5-pro-exp-0801'
};

// Factory function to create a stateful OpenAI chat
export function openAIChat(clientClass) {
  const messages = [];

  async function ask(userMessage, { system, model, temperature = 0.0, max_tokens = 8192, stream = true, shorten = (x => x) }) {
    if (userMessage === null) {
      return { messages };
    }

    model = MODELS[model] || model;
    const client = new clientClass({ apiKey: await getToken(clientClass.name.toLowerCase()) });

    const is_o1 = model.startsWith("o1");

    // FIXME: update when OAI's o1 API flexibilizes
    var max_completion_tokens = undefined;
    if (is_o1) {
      stream = false;
      temperature = 1;
      max_completion_tokens = max_tokens;
      max_tokens = undefined;
    }

    if (messages.length === 0 && system) {
      // FIXME: update when OAI's o1 API flexibilizes
      if (is_o1) {
        messages.push({ role: "user", content: system });
      } else {
        messages.push({ role: "system", content: system });
      }
    }

    messages.push({ role: "user", content: userMessage });

    const params = {
      messages,
      model,
      temperature,
      max_tokens,
      max_completion_tokens,
      stream,
    };

    let result = "";
    const response = await client.chat.completions.create(params);
    if (stream) {
      for await (const chunk of response) {
        const text = chunk.choices[0]?.delta?.content || "";
        process.stdout.write(text);
        result += text;
      }
    } else {
      const text = response.choices[0]?.message?.content || "";
      process.stdout.write(text);
      result = text;
    }

    messages.push({ role: 'assistant', content: await shorten(result) });

    return result;
  }

  return ask;
}

// Factory function to create a stateful Anthropic chat
export function anthropicChat(clientClass) {
  const messages = [];

  async function ask(userMessage, { system, model, temperature = 0.0, max_tokens = 8192, stream = true, system_cacheable = false, shorten = (x => x) }) {
    if (userMessage === null) {
      return { messages };
    }

    model = MODELS[model] || model;
    const client = new clientClass({ 
      apiKey: await getToken(clientClass.name.toLowerCase()),
      defaultHeaders: {
        "anthropic-beta": "prompt-caching-2024-07-31" // Enable prompt caching
      }
    });

    messages.push({ role: "user", content: userMessage });

    const cached_system = [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];

    let prompt_system = system_cacheable ? cached_system : system;
    const params = { system: prompt_system, model, temperature, max_tokens, stream };

    let result = "";
    const response = client.messages
      .stream({ ...params, messages })
      .on('text', (text) => {
        process.stdout.write(text);
        result += text;
      });
    await response.finalMessage();

    messages.push({ role: 'assistant', content: await shorten(result) });

    return result;
  }

  return ask;
}

export function geminiChat(clientClass) {
  const messages = [];

  async function ask(userMessage, { system, model, temperature = 0.0, max_tokens = 4096, stream = true, shorten = (x => x) }) {
    if (userMessage === null) {
      return { messages };
    }

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

    messages.push({ role: 'model', parts: [{ text: await shorten(result) }] });

    return result;
  }

  return ask;
}

// Factory function to create a stateful OpenRouter chat
export function openRouterChat(clientClass) {
  const messages = [];

  async function ask(userMessage, { system, model, temperature = 0.0, max_tokens = 8192, stream = true, shorten = (x => x) }) {
    if (userMessage === null) {
      return { messages };
    }

    model = MODELS[model] || model;
    const openai = new OpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: await getToken('openrouter'),
      defaultHeaders: {
        "HTTP-Referer": "https://github.com/OpenRouterTeam/openrouter-examples",
      },
    });

    if (messages.length === 0 && system) {
      messages.push({ role: "system", content: system });
    }

    messages.push({ role: "user", content: userMessage });

    const params = {
      messages,
      model,
      temperature,
      max_tokens,
      stream,
    };

    let result = "";
    const response = await openai.chat.completions.create(params);
    if (stream) {
      for await (const chunk of response) {
        const text = chunk.choices[0]?.delta?.content || "";
        process.stdout.write(text);
        result += text;
      }
    } else {
      const text = response.choices[0]?.message?.content || "";
      process.stdout.write(text);
      result = text;
    }

    messages.push({ role: 'assistant', content: await shorten(result) });

    return result;
  }

  return ask;
}

// Generic asker function that dispatches to the correct asker based on the model name
export function chat(model) {
  model = MODELS[model] || model;
  if (model.startsWith('gpt')) {
    return openAIChat(OpenAI);
  } else if (model.startsWith('o1')) {
    return openAIChat(OpenAI);
  } else if (model.startsWith('chatgpt')) {
    return openAIChat(OpenAI);
  } else if (model.startsWith('claude')) {
    return anthropicChat(Anthropic);
  } else if (model.startsWith('meta')) {
    return openRouterChat(OpenRouter);
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









