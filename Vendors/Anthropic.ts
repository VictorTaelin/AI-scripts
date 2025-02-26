import { Anthropic } from '@anthropic-ai/sdk';
import { AskOptions, ChatInstance } from "../GenAI";

export class AnthropicChat implements ChatInstance {
  private client: Anthropic;
  private messages: { role: "user" | "assistant"; content: string | any[] }[] = [];
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({
      apiKey,
      defaultHeaders: {
        "anthropic-beta": "prompt-caching-2024-07-31"
      }
    });
    this.model = model;
  }

  async ask(userMessage: string | null, options: AskOptions): Promise<string | { messages: { role: string; content: any }[] }> {
    if (userMessage === null) {
      return { messages: this.messages };
    }

    // Extract options with defaults
    let { system, temperature = 0.0, max_tokens = 64000, stream = true, system_cacheable = false } = options;

    // Determine if thinking should be enabled based on model suffix
    const enableThinking = this.model.endsWith('-think');
    const baseModel = enableThinking ? this.model.replace('-think', '') : this.model;

    // When thinking is enabled, temperature must be 1.0 as per API requirements
    if (enableThinking) {
      temperature = 1.0;
    }

    // Add user message to chat history
    this.messages.push({ role: "user", content: userMessage });

    // Construct API request parameters
    const params: Anthropic.MessageCreateParams = {
      system: system_cacheable && system
        ? ([{ type: "text", text: system, cache_control: { type: "ephemeral" } }] as any)
        : system,
      model: baseModel,
      temperature,
      max_tokens,
      stream,
      messages: this.messages as any,
    };

    // Enable thinking feature if model ends with '-think'
    if (enableThinking) {
      (params as any).thinking = {
        type: "enabled",
        budget_tokens: 8192*1.5,
      };
    }

    let result = "";
    if (stream) {
      // Handle streaming response with dim styling for thinking tokens
      const stream = this.client.messages.stream(params);
      let assistantContent: any[] = [];
      let hasPrintedThinking = false; // Track if thinking content was printed

      for await (const event of stream) {
        if (event.type === 'content_block_start') {
          assistantContent.push({ ...event.content_block });
        } else if (event.type === 'content_block_delta') {
          const index = event.index;
          const delta = event.delta;
          if (delta.type === 'thinking_delta') {
            // Apply dim styling to thinking tokens for console output
            process.stdout.write(`\x1b[2m${delta.thinking}\x1b[0m`);
            assistantContent[index].thinking += delta.thinking;
            result += delta.thinking;
            hasPrintedThinking = true; // Set flag when thinking is printed
          } else if (delta.type === 'text_delta') {
            // Add newline before text if thinking was printed
            if (hasPrintedThinking) {
              process.stdout.write('\n');
              hasPrintedThinking = false; // Reset flag after newline
            }
            process.stdout.write(delta.text);
            assistantContent[index].text += delta.text;
            result += delta.text;
          } else if (delta.type === 'signature_delta') {
            assistantContent[index].signature = delta.signature;
          }
        }
      }
      process.stdout.write("\n"); // Final newline after response
      this.messages.push({ role: "assistant", content: assistantContent });
    } else {
      // Handle non-streaming response with dim styling for thinking tokens
      const message = await this.client.messages.create(params);
      const content = message.content;
      let styledText = '';
      let plainText = '';
      let hasPrintedThinking = false; // Track if thinking content was printed

      for (const block of content) {
        if (block.type === 'thinking') {
          // Apply dim styling to thinking blocks for console output
          styledText += `\x1b[2m${block.thinking}\x1b[0m`;
          plainText += block.thinking;
          hasPrintedThinking = true; // Set flag when thinking is added
        } else if (block.type === 'text') {
          // Add newline before text if thinking was printed
          if (hasPrintedThinking) {
            styledText += '\n';
            plainText += '\n';
            hasPrintedThinking = false; // Reset flag after newline
          }
          styledText += block.text;
          plainText += block.text;
        }
      }
      process.stdout.write(styledText);
      this.messages.push({ role: "assistant", content: content });
      result = plainText;
    }

    return result;
  }
}
