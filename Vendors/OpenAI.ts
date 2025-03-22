import OpenAI from "openai";
import { AskOptions, ChatInstance } from "../GenAI";

export class OpenAIChat implements ChatInstance {
  private client: OpenAI;
  private messages: { role: "user" | "assistant" | "system"; content: string }[] = [];
  private model: string;
  private vendor: string;

  constructor(apiKey: string, baseURL: string, model: string, vendor: string) {
    if (vendor === 'openrouter') {
      this.client = new OpenAI({
        apiKey,
        baseURL,
        defaultHeaders: {
          "HTTP-Referer": "https://github.com/OpenRouterTeam/openrouter-examples",
        },
      });
    } else {
      this.client = new OpenAI({ apiKey, baseURL });
    }
    this.model = model;
    this.vendor = vendor;
  }

  async ask(userMessage: string | null, options: AskOptions): Promise<string | { messages: { role: string; content: string }[] }> {
    if (userMessage === null) {
      return { messages: this.messages };
    }

    let { system, temperature = 0.0, max_tokens = 8192, stream = true } = options;

    const is_o_series = this.model.startsWith("o1") || this.model.startsWith("o3");

    let max_completion_tokens: number | undefined;
    let reasoning_effort: string | undefined;

    if (is_o_series) {
      stream = this.model.startsWith("o3"); // streaming only for o3
      temperature = 1;
      max_completion_tokens = 100000; // Default for o-series if not specified
      reasoning_effort = "high";
    }

    // Update or set the system message if provided
    if (system) {
      if (this.messages.length > 0 && this.messages[0].role === "system") {
        this.messages[0].content = system; // Update existing system message
      } else {
        this.messages.unshift({ role: is_o_series ? "user" : "system", content: system }); // Add new system message at the start
      }
    }

    this.messages.push({ role: "user", content: userMessage });

    const params: OpenAI.Chat.Completions.ChatCompletionCreateParams = {
      messages: this.messages,
      model: this.model,
      temperature,
      stream,
      ...(is_o_series ? { max_completion_tokens: max_completion_tokens ?? max_tokens } : { max_tokens }),
    };

    if (reasoning_effort && this.vendor === 'deepseek') {
      (params as any).reasoning_effort = reasoning_effort;
    }

    let result = "";
    if (stream) {
      const streamResponse = await this.client.chat.completions.create({
        ...params,
        stream: true,
      });
      var is_reasoning = false;
      for await (const chunk of streamResponse) {
        if (this.vendor === "deepseek" && (chunk as any).choices[0]?.delta?.reasoning_content) {
          const text = (chunk as any).choices[0].delta.reasoning_content;
          process.stdout.write('\x1b[2m' + text + '\x1b[0m');
          is_reasoning = true;
        } else if (chunk.choices[0]?.delta?.content) {
          if (is_reasoning) { is_reasoning = false; process.stdout.write("\n"); }
          const text = chunk.choices[0].delta.content;
          process.stdout.write(text);
          result += text;
        }
      }
      process.stdout.write("\n");
    } else {
      const completionResponse = await this.client.chat.completions.create({
        ...params,
        stream: false,
      });
      if (this.vendor === "deepseek") {
        const reasoning_content = (completionResponse as any).choices[0]?.message?.reasoning_content || "";
        if (reasoning_content) process.stdout.write(reasoning_content);
      }
      const text = completionResponse.choices[0]?.message?.content || "";
      result = text;
      if (is_o_series && this.model.startsWith("o1")) console.log(result);
    }

    this.messages.push({ role: "assistant", content: result });
    return result;
  }
}
import fetch from 'node-fetch'; // Assuming node-fetch is used for HTTP requests
import { ChatInstance, AskOptions } from '../types'; // Assuming types are imported from a types file

export class OpenAIChat implements ChatInstance {
  private apiKey: string;
  private baseURL: string;
  private model: string;
  private vendor: string;
  private messages: any[] = []; // Stores conversation history

  constructor(apiKey: string, baseURL: string, model: string, vendor: string) {
    this.apiKey = apiKey;
    this.baseURL = baseURL;
    this.model = model;
    this.vendor = vendor;
  }

  async ask(userMessage: string | null, options: AskOptions): Promise<string | { messages: any[] }> {
    const isO1Model = this.model.startsWith('o1'); // Covers o1-mini, o1, o1-pro-2025-03-19, etc.

    if (isO1Model) {
      // Handle o1 models (e.g., o1-pro) with /v1/responses endpoint, non-streaming
      let input = options.system ? `${options.system}\n\n` : '';
      this.messages.forEach(msg => {
        input += `${msg.role.charAt(0).toUpperCase() + msg.role.slice(1)}: ${msg.content}\n`;
      });
      if (userMessage) {
        input += `User: ${userMessage}\n`;
      }

      const payload = {
        model: this.model,
        input: input,
        temperature: options.temperature || 0.7,
        max_tokens: options.max_tokens || 4096,
        // Streaming is not supported for o1 models, so it's omitted
      };

      const response = await fetch(`${this.baseURL}/responses`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      let answer = '';
      if (data.output && Array.isArray(data.output)) {
        for (const entry of data.output) {
          if (entry.type === 'message' && entry.role === 'assistant') {
            for (const segment of entry.content) {
              if (segment.type === 'output_text') {
                answer += segment.text;
              }
            }
          }
        }
      }

      // Update conversation history
      if (userMessage) {
        this.messages.push({ role: 'user', content: userMessage });
      }
      this.messages.push({ role: 'assistant', content: answer });

      return answer;
    } else {
      // Handle other OpenAI models (e.g., GPT series) with /v1/chat/completions
      let messages = [...this.messages];
      if (options.system) {
        messages.unshift({ role: 'system', content: options.system });
      }
      if (userMessage) {
        messages.push({ role: 'user', content: userMessage });
      }

      const payload = {
        model: this.model,
        messages: messages,
        stream: options.stream, // Streaming remains available for non-o1 OpenAI models
        temperature: options.temperature || 0.7,
        max_tokens: options.max_tokens || 4096,
      };

      if (options.stream) {
        // Placeholder for streaming logic (to be replaced with your original implementation)
        // This assumes the original code handles streaming correctly for GPT models
        const response = await fetch(`${this.baseURL}/chat/completions`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });

        // Note: Actual streaming implementation (e.g., async generator) is not shown
        // as it depends on your existing code. This is a placeholder.
        return { messages: [] };
      } else {
        // Non-streaming logic for other models
        const response = await fetch(`${this.baseURL}/chat/completions`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          throw new Error(`API error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        const answer = data.choices[0].message.content;

        // Update conversation history
        if (userMessage) {
          this.messages.push({ role: 'user', content: userMessage });
        }
        this.messages.push({ role: 'assistant', content: answer });

        return answer;
      }
    }
  }
}
