GenAI.ts
=======
GenAI.ts is a TypeScript library providing a unified interface for interacting with various AI language models from providers like OpenAI, Anthropic, Google, and others. It enables stateful chat interactions, allowing users to send messages and receive responses from AI models seamlessly.

The library abstracts the complexities of different AI APIs, enabling easy switching between models or providers without code changes. It supports features like streaming responses, temperature control, and system prompts where applicable.

Usage
-----
```typescript
import { GenAI } from './GenAI';

async function main() {
  const ai = await GenAI("g"); // Model: GPT-4o

  // Options
  const opts = {
    system: "You are a helpful assistant.",
    temperature: 0.0,
    stream: true,
  };

  // Send a message
  const response1 = await ai.ask("Hello, how are you?", opts);
  console.log(response1);

  // Send another message
  const response2 = await ai.ask("What did I just say?", opts);
  console.log(response2);

  // Get conversation history
  const history = await ai.ask(null, opts);
  console.log(history);
}
```
In this example, we create a chat instance for GPT-4o, send two messages, and then retrieve the conversation history.

Models
------
The library supports various AI models via shortcodes defined in the `MODELS` export:

- `g`: GPT-4o
- `G`: o3-mini
- `o`: o1
- `cm`: Claude-3.5-Haiku
- `c`: Claude-3.5-Sonnet
- `C`: Claude-3.5-Sonnet (latest)
- `d`: DeepSeek-Chat
- `D`: DeepSeek-Reasoner
- `lm`: Llama-3.1-8B-Instruct
- `l`: Llama-3.3-70B-Instruct
- `L`: Llama-3.1-405B-Instruct
- `i`: Gemini-2.0-Pro
- `I`: Gemini-2.0-Flash
- `x`: Grok-3
- `X`: Grok-3-Think

Use uppercase letters (e.g., `G`) for smarter, slower versions where available. You can also use full model names if not listed.

API Reference
-------------
### GenAI
Creates and returns a chat instance for the specified model.

**Signature:** `async function GenAI(modelShortcode: string): Promise<ChatInstance>`  
**Parameters:**  
- `modelShortcode: string` - Model shortcode (e.g., "g") or full model name.  
**Returns:** A promise resolving to a `ChatInstance`.

### ChatInstance
Interface for chat interactions.

#### ask
**Signature:** `ask(userMessage: string | null, options: AskOptions): Promise<string | { messages: { role: string; content: string }[] }>`  
**Parameters:**  
- `userMessage: string | null` - Message to send. If `null`, returns conversation history.  
- `options: AskOptions` - Configuration options.  
**Returns:**  
- If `userMessage` is a string: AI's response as a string.  
- If `userMessage` is `null`: Object containing conversation history.  
**Note:** When `stream` is `true`, the response is streamed to `stdout`, and the full response is still returned as a string.

### AskOptions
Options for the `ask` method:

- `system?: string` - System prompt to set assistant behavior.
- `temperature?: number` - Controls response randomness (0.0 to 1.0). Default: 0.0.
- `max_tokens?: number` - Maximum tokens to generate. Default: 8192.
- `stream?: boolean` - Enable streaming. Default: `true` where supported.
- `system_cacheable?: boolean` - Allow caching the system message (Anthropic-specific).
- `reasoning_effort?: string` - Set reasoning effort (DeepSeek-specific).

**Note:** Not all options apply to every model; unsupported options are ignored.

### MODELS
Record mapping shortcodes to model names. See [Models](#models) for details.

### tokenCount
Estimates token count using GPT-4o's tokenizer.

**Signature:** `function tokenCount(text: string): number`  
**Parameters:**  
- `text: string` - Text to analyze.  
**Returns:** Estimated token count.  
**Note:** This is an approximation; actual counts may vary by model.

Setup
-----
Ensure API keys are set in `~/.config/<vendor>.token` (e.g., `~/.config/openai.token`). Supported vendors: `openai`, `anthropic`, `deepseek`, `openrouter`, `google`, `kimi`, `xai`, `cerebras`.

For OpenRouter, the library sets the `HTTP-Referer` header to `"https://github.com/OpenRouterTeam/openrouter-examples"`.

Additional Notes
----------------
- **Streaming:** When enabled, responses are streamed to `stdout`. For DeepSeek models, reasoning content is displayed in dim text.
- **Model-Specific Features:** Some models have unique behaviors (e.g., o1/o3 series handle streaming and temperature differently).
- **Token Estimation:** `tokenCount` uses GPT-4o's tokenizer, which may differ from other models' tokenization.
