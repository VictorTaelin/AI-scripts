// this is probably the worst code I've ever written
// why are you guys using it
// stop
// i beg you

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { OpenAI } from "openai";
import { Anthropic } from '@anthropic-ai/sdk';
import { OpenRouter } from "@openrouter/ai-sdk-provider";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { encode } from "gpt-tokenizer/esm/model/davinci-codex"; // tokenizer
import { Scraper } from 'agent-twitter-client-taelin-fork';

// Map of model shortcodes to full model names
export const MODELS = {
  // GPT by OpenAI
  gm: 'gpt-4o-mini',
  g: 'chatgpt-4o-latest',
  //g: 'gpt-4o-2024-11-20',
  //g: 'gpt-4o',
  //G: 'gpt-4-32k-0314',

  // o1 by OpenAI
  om: 'o3-mini',
  o: 'o1',

  // Claude by Anthropic
  cm: 'claude-3-5-haiku-20241022',
  C: 'claude-3-5-sonnet-20241022',
  c: 'claude-3-5-sonnet-20240620',

  k: 'deepseek-chat',
  K: 'deepseek-reasoner',

  //c: 'claude-3-5-sonnet-20240620',
  //C: 'claude-3-5-sonnet-20241022', // TODO: temporarily using the new sonnet instead of opus

  //C: 'claude-3-opus-20240229',

  // Llama by Meta
  lm: 'meta-llama/llama-3.1-8b-instruct',
  l: 'meta-llama/llama-3.3-70b-instruct',
  L: 'meta-llama/llama-3.1-405b-instruct',

  //s: 'DeepSeek-R1-Distill-Llama-70B',

  // Gemini by Google
  i: 'gemini-2.0-pro-exp-02-05',
  I: 'gemini-2.0-flash-thinking-exp-01-21',

  x: "grok-3",
  X: "grok-3-think",
};

// Factory function to create a stateful OpenAI chat
export function openAIChat(clientClass, use_model) {
  const messages = [];
  let extendFunction = null;

  async function ask(userMessage, { system, model, temperature = 0.0, max_tokens = 8192, stream = true, shorten = (x => x), extend = null, predict = null }) {
    if (userMessage === null) {
      return { messages };
    }

    let reasoning_effort = undefined;

    model = MODELS[model] || model || use_model;
    const client = new clientClass({ apiKey: await getToken(clientClass.name.toLowerCase()) });

    const is_o1 = model.startsWith("o1");
    const is_o3 = model.startsWith("o3");

    // FIXME: update when OAI's o1 API flexibilizes
    var max_completion_tokens = undefined;
    var old_stream = stream;
    if (is_o1 || is_o3) {
      stream = false;
      temperature = 1;
      max_completion_tokens = 100000;
      max_tokens = undefined;
      reasoning_effort = "high";
    }
    if (is_o3) {
      stream = true;
    }

    if (messages.length === 0 && system) {
      // FIXME: update when OAI's o1 API flexibilizes
      if (is_o1 || is_o3) {
        messages.push({ role: "user", content: system });
      } else {
        messages.push({ role: "system", content: system });
      }
    }

    let extendedUserMessage = extendFunction ? extendFunction(userMessage) : userMessage;
    extendFunction = extend; // Set for next call

    const messagesCopy = [...messages, { role: "user", content: extendedUserMessage }];
    messages.push({ role: "user", content: userMessage });

    const prediction = predict && model.indexOf("o1") === -1 && model.indexOf("o3") === -1 ? { type: "content", content: predict } : undefined;
    //console.log(prediction);

    const params = {
      messages: messagesCopy,
      model,
      temperature,
      max_tokens,
      max_completion_tokens,
      reasoning_effort,
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
      //process.stdout.write(text);
      result = text;
    }

    //console.log(is_o1, old_stream);
    if (is_o1 && old_stream) {
      console.log(result);
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

export function geminiChat(clientClass, use_model) {
  const messages = [];

  async function ask(userMessage, {system, model, temperature = 0.0, max_tokens = 8192, stream = true, shorten = (x) => x, extend = null}) {
    if (userMessage === null) {
      return { messages };
    }

    model = MODELS[model] || model || use_model;
    const client = new clientClass(await getToken(clientClass.name.toLowerCase()));

    const generationConfig = {
      maxOutputTokens: max_tokens,
      temperature,
    };

    const safetySettings = [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
    ];

    // Initialize the chat with the system prompt integrated as expected by Gemini's API
    const chat = client
      .getGenerativeModel({ model, generationConfig })
      .startChat({
        safetySettings,
        systemInstruction: { role: "system", parts: [{ text: system }] },
      });

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
      //process.stdout.write(text);
      result = text;
    }

    messages.push({ role: 'assistant', content: await shorten(result) });

    return result;
  }

  return ask;
}

// Factory function to create a stateful Deepseek chat
export function deepseekChat(clientClass, use_model) {
  const messages = [];
  let extendFunction = null;

  async function ask(userMessage, { system, model, temperature = 0.0, max_tokens = 8192, stream = true, shorten = (x => x), extend = null, reasoning_effort = "high" }) {
    if (userMessage === null) {
      return { messages };
    }

    model = MODELS[model] || model || use_model;
    const client = new clientClass({
      apiKey: await getToken('deepseek'),
      baseURL: "https://api.deepseek.com/v1",
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
      model: model,
      temperature,
      max_tokens,
      stream,
      reasoning_effort,
      response_format: { type: "text" }
    };

    let result = "";
    let reasoning_content = "";
    const response = await client.chat.completions.create(params);
    if (stream) {
      for await (const chunk of response) {
        if (chunk.choices[0]?.delta?.reasoning_content) {
          const text = chunk.choices[0].delta.reasoning_content;
          process.stdout.write(text);
          reasoning_content += text;
        } else if (chunk.choices[0]?.delta?.content) {
          if (result === "") console.log("");
          const text = chunk.choices[0].delta.content;
          process.stdout.write(text);
          result += text;
        }
      }
    } else {
      reasoning_content = response.choices[0]?.message?.reasoning_content || "";
      result = response.choices[0]?.message?.content || "";
      if (reasoning_content) process.stdout.write(reasoning_content);
      //process.stdout.write(result);
    }

    messages.push({ role: 'assistant', content: await shorten(result) });

    return result;
  }

  return ask;
}

export function sambanovaChat(clientClass, use_model) {
  // Initialize an array to store the conversation history
  const messages = [];
  // Variable to store the extend function for the next call
  let extendFunction = null;

  // The ask function handles the chat interaction
  async function ask(userMessage, { 
    system, 
    model, 
    temperature = 0.0, 
    max_tokens = 8192, 
    stream = true, 
    shorten = (x => x), 
    extend = null 
  }) {
    // If userMessage is null, return the current messages array
    if (userMessage === null) {
      return { messages };
    }

    // Determine the model to use, falling back to the default if not specified
    model = MODELS[model] || model || use_model;

    // Initialize the OpenAI client with SambaNova's base URL and API key
    const client = new clientClass({
      apiKey: await getToken('sambanova'),
      baseURL: "https://api.sambanova.ai/v1",
    });

    // Add system message if provided and this is the first message
    if (messages.length === 0 && system) {
      messages.push({ role: "system", content: system });
    }

    // Apply the extend function from the previous call, if any
    let extendedUserMessage = extendFunction ? extendFunction(userMessage) : userMessage;
    // Set the extend function for the next call
    extendFunction = extend;

    // Create a copy of messages with the extended user message for the API call
    const messagesCopy = [...messages, { role: "user", content: extendedUserMessage }];
    // Add the original user message to the persistent message history
    messages.push({ role: "user", content: userMessage });

    // Define parameters for the API call, excluding unsupported SambaNova parameters
    const params = {
      messages: messagesCopy,
      model,
      temperature,
      max_tokens,
      stream,
    };

    let result = "";
    // Make the API call to SambaNova
    const response = await client.chat.completions.create(params);

    // Handle streaming response
    if (stream) {
      for await (const chunk of response) {
        const text = chunk.choices[0]?.delta?.content || "";
        process.stdout.write(text);
        result += text;
      }
    } 
    // Handle non-streaming response
    else {
      const text = response.choices[0]?.message?.content || "";
      result = text;
    }

    // Add the assistant's response to the message history after shortening
    messages.push({ role: 'assistant', content: await shorten(result) });

    return result;
  }

  return ask;
}

class GrokChat {
  constructor(model) {
    this.scraper = null;
    this.conversationId = null;
    this.messages = [];
    this.cookies = null;
    this.model = model;
  }

  async initialize() {
    if (!this.scraper) {
      const configPath = path.join(os.homedir(), '.config', 'twitter.pwd');
      let credentials;
      try {
        const data = await fs.readFile(configPath, 'utf8');
        credentials = JSON.parse(data);
      } catch (err) {
        console.error('Error reading twitter.pwd file:', err.message);
        throw new Error('Failed to load Twitter credentials');
      }

      const { user, pass, email } = credentials;
      if (!user || !pass) {
        throw new Error('twitter.pwd must contain "user" and "pass" fields');
      }

      this.scraper = new Scraper();

      // Load cookies if available
      const cookiesPath = path.join(os.homedir(), '.config', 'twitter.cookies');
      try {
        const cookiesData = await fs.readFile(cookiesPath, 'utf8');
        const cookieStrings = JSON.parse(cookiesData);
        const loadedCookies = cookieStrings.filter(cookie => cookie !== undefined);
        await this.scraper.setCookies(loadedCookies);
        //console.log('Loaded cookies from file');
      } catch (err) {
        //console.log('No cookies found or error loading cookies:', err.message);
        this.cookies = null;
      }
      // Only log in if not already logged in
      if (!(await this.scraper.isLoggedIn())) {
          try {
            await this.scraper.login(user, pass, email || undefined);
            //console.log('Successfully logged in to Twitter');
            // Cache the new cookies
            this.cookies = await this.scraper.getCookies();
            const cookieStrings = this.cookies.map(cookie => cookie.toString());
            await fs.writeFile(cookiesPath, JSON.stringify(cookieStrings), 'utf8');
            //console.log('Saved cookies to file');
          } catch (err) {
            //console.error('Twitter login error details:', err.message);
            throw new Error('Twitter login failed');
          }
      } else {
        //console.log('Already logged in (using cookies)');
      }
    }
  }

  async chat(userMessage, options = {}) {
    await this.initialize();
    const messagesToSend = [{ role: 'user', content: userMessage }];

    try {
      const model = MODELS[options.model || this.model || "grok-3"];
      const response = await this.scraper.grokChat({
        grokModelOptionId: model.replace("-think", ""),
        messages: messagesToSend,
        conversationId: this.conversationId,
        isReasoning: model.endsWith("-think") || false,
        returnSearchResults: false,
        returnCitations: false,
        stream: options.stream || true,
        ...options,
      });

      this.conversationId = response.conversationId;
      this.messages = response.messages;

      if (response.rateLimit?.isRateLimited) {
        console.warn(`Rate limit exceeded: ${response.rateLimit.message}`);
      }

      return response.message;
    } catch (err) {
      console.error('Error interacting with Grok:', err.message);
      throw err;
    }
  }

  getMessages() {
    return this.messages;
  }

  resetConversation() {
    this.conversationId = null;
    this.messages = [];
  }
}

export function grokChat(model) {
  const grok = new GrokChat(model);

  async function ask(userMessage, { stream = true, ...options } = {}) {
    if (userMessage === null) {
      return { messages: grok.getMessages() };
    }
    return await grok.chat(userMessage, options);
    // NOTE: when stream=true, my forked twitter lib will already print Grok's output
  }

  return ask;
}

// Generic asker function that dispatches to the correct asker based on the model name
// this is terrible kill me
export function chat(model) {
  model = MODELS[model] || model;
  if (model.startsWith('grok')) {
    return grokChat(model);
  } else if (model.startsWith('gpt')) {
    return openAIChat(OpenAI, model);
  } else if (model.startsWith('o1')) {
    return openAIChat(OpenAI, model);
  } else if (model.startsWith('o3')) {
    return openAIChat(OpenAI, model);
  } else if (model.startsWith('chatgpt')) {
    return openAIChat(OpenAI, model);
  } else if (model.startsWith('deepseek')) {
    return deepseekChat(OpenAI, model);
  } else if (model.startsWith('claude')) {
    return anthropicChat(Anthropic, model);
  } else if (model.startsWith('meta')) {
    return openRouterChat(OpenRouter, model);
  //} else if (model.startsWith('Meta')) {
    //return sambanovaChat(OpenAI, model);
  //} else if (model === "DeepSeek-R1-Distill-Llama-70B") {
    //return sambanovaChat(OpenAI, model);
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

async function getLogin(vendor) {
  const loginPath = path.join(os.homedir(), '.config', `${vendor}.pwd`);
  try {
    const loginData = await fs.readFile(loginPath, 'utf8');
    return JSON.parse(loginData);
  } catch (err) {
    console.error(`Error reading or parsing ${vendor}.pwd file:`, err.message);
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
