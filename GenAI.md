GenAI.ts
=======
GenAI.ts is a TypeScript library providing a unified interface for interacting with various AI language models from providers like OpenAI, Anthropic, Google, and others. It enables stateful chat interactions, allowing users to send messages and receive responses from AI models seamlessly.

The library abstracts the complexities of different AI APIs, enabling easy switching between models or providers without code changes. It supports features like streaming responses, temperature control, and system prompts where applicable.

Usage
-----
```typescript
import { GenAI } from './GenAI';

async function main() {
  const ai = await GenAI("openai:gpt-5.1:medium");

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
Models are now referenced using the canonical `vendor:official_model_name:thinking_budget`
format, for example:

- `openai:gpt-5.1:high`
- `anthropic:claude-sonnet-4-5-20250929:medium`
- `google:gemini-2.5-pro:medium`
- `openrouter:meta-llama/llama-3.3-70b-instruct:auto`
- `xai:grok-4-0709:auto`

The optional third segment controls the thinking budget (`none | low | medium | high | auto`).
Legacy shortcodes remain available via the `MODELS` export for convenience. Each shortcut
follows a consistent pattern:

- Each character (`g`, `G`, `c`, `C`, `l`, `L`, etc.) maps directly to a specific
  vendor/model pairing (e.g., `c` is Claude Sonnet, `C` is Claude Opus, `g` and `G`
  both map to GPT‑5.1).
- Append `-` to request the low thinking budget, omit it for medium, and append `+`
  for high (e.g., `g-`, `g`, `g+` map to `openai:gpt-5.1:low|medium|high`).

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
- `temperature?: number` - Controls response randomness. Omitted by default.
- `max_tokens?: number` - Maximum tokens to generate (chat-completions style APIs).
- `max_completion_tokens?: number` - Maximum output tokens (Responses API).
- `stream?: boolean` - Enable streaming. Default: `true` where supported.
- `system_cacheable?: boolean` - Allow caching the system message (Anthropic-specific).
- `vendorConfig?: VendorConfig` - Optional per-call overrides for vendor-specific knobs
  computed in `GenAI.ts` (e.g., reasoning effort, thinking budgets).

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
Ensure API keys are set in `~/.config/<vendor>.token` (e.g., `~/.config/openai.token`).
Supported vendors are `openai`, `anthropic`, `google`, `openrouter`, and `xai`.

For OpenRouter, the library sets the `HTTP-Referer` header to `"https://github.com/OpenRouterTeam/openrouter-examples"`.

Additional Notes
----------------
- **Streaming:** When enabled, responses are streamed to `stdout`. When vendors expose
  explicit thinking traces (OpenAI Responses, Anthropic, Gemini), they are printed
  in dim gray before the final answer.
- **Thinking Budgets:** Thinking levels are centrally managed in `GenAI.ts` and forwarded
  to each vendor in an idiomatic way (e.g., OpenAI reasoning effort, Anthropic
  `thinking` blocks, Gemini `thinkingConfig`).
- **Token Estimation:** `tokenCount` uses GPT-4o's tokenizer, which may differ from other models' tokenization.
