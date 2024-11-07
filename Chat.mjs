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
  g: 'chatgpt-4o-latest',
  //g: 'gpt-4o',
  //G: 'gpt-4-32k-0314',

  // o1 by OpenAI
  om: 'o1-mini',
  o: 'o1-preview',

  // Claude by Anthropic
  cm: 'claude-3-5-haiku-20241022',

  c: 'claude-3-5-sonnet-20241022',
  C: 'claude-3-5-sonnet-20240620',

  //c: 'claude-3-5-sonnet-20240620',
  //C: 'claude-3-5-sonnet-20241022', // TODO: temporarily using the new sonnet instead of opus

  //C: 'claude-3-opus-20240229',

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
  let extendFunction = null;

  async function ask(userMessage, { system, model, temperature = 0.0, max_tokens = 8192, stream = true, shorten = (x => x), extend = null, predict = null }) {
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

    let extendedUserMessage = extendFunction ? extendFunction(userMessage) : userMessage;
    extendFunction = extend; // Set for next call

    const messagesCopy = [...messages, { role: "user", content: extendedUserMessage }];
    messages.push({ role: "user", content: userMessage });

    const prediction = predict && model.indexOf("o1") === -1 ? { type: "content", content: predict } : undefined;
    //console.log(prediction);

    const params = {
      messages: messagesCopy,
      model,
      temperature,
      max_tokens,
      max_completion_tokens,
      stream,
      prediction,
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
export function anthropicChat(clientClass, MODEL) {
  const messages = [];

  async function ask(userMessage, { system, model, temperature = 0.0, max_tokens = 8192, stream = true, system_cacheable = false, shorten = (x => x), extend = null }) {
    if (userMessage === null) {
      return { messages };
    }

    model = model || MODEL;
    model = MODELS[model] || model;
    const client = new clientClass({ 
      apiKey: await getToken(clientClass.name.toLowerCase()),
      defaultHeaders: {
        "anthropic-beta": "prompt-caching-2024-07-31" // Enable prompt caching
      }
    });

    let extendedUserMessage = extend ? extend(userMessage) : userMessage;

    const messagesCopy = [...messages, { role: "user", content: extendedUserMessage }];
    messages.push({ role: "user", content: userMessage });

    const cached_system = [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];

    let prompt_system = system_cacheable ? cached_system : system;
    const params = { system: prompt_system, model, temperature, max_tokens, stream };

    //console.log("->", extend, JSON.stringify(messagesCopy, null, 2));

    let result = "";
    const response = client.messages
      .stream({ ...params, messages: messagesCopy })
      .on('text', (text) => {
        if (stream) {
          process.stdout.write(text);
        }
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
  let extendFunction = null;

  async function ask(userMessage, { system, model, temperature = 0.0, max_tokens = 4096, stream = true, shorten = (x => x), extend = null }) {
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

    let extendedUserMessage = extendFunction ? extendFunction(userMessage) : userMessage;
    extendFunction = extend; // Set for next call

    const messagesCopy = [...messages, { role: "user", parts: [{ text: extendedUserMessage }] }];
    messages.push({ role: "user", parts: [{ text: userMessage }] });

    const chat = client.getGenerativeModel({ model, generationConfig })
      .startChat({
        history: messagesCopy,
        safetySettings: safetySettings,
      });

    let result = "";
    if (stream) {
      const response = await chat.sendMessageStream(extendedUserMessage);
      for await (const chunk of response.stream) {
        const text = chunk.text();
        process.stdout.write(text);
        result += text;
      }
    } else {
      const response = await chat.sendMessage(extendedUserMessage);
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
  let extendFunction = null;

  async function ask(userMessage, { system, model, temperature = 0.0, max_tokens = 8192, stream = true, shorten = (x => x), extend = null }) {
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

    let extendedUserMessage = extendFunction ? extendFunction(userMessage) : userMessage;
    extendFunction = extend; // Set for next call

    const messagesCopy = [...messages, { role: "user", content: extendedUserMessage }];
    messages.push({ role: "user", content: userMessage });

    const params = {
      messages: messagesCopy,
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
    return openAIChat(OpenAI, model);
  } else if (model.startsWith('o1')) {
    return openAIChat(OpenAI, model);
  } else if (model.startsWith('chatgpt')) {
    return openAIChat(OpenAI, model);
  } else if (model.startsWith('claude')) {
    return anthropicChat(Anthropic, model);
  } else if (model.startsWith('meta')) {
    return openRouterChat(OpenRouter, model);
  } else if (model.startsWith('gemini')) {
    return geminiChat(GoogleGenerativeAI, model);
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

