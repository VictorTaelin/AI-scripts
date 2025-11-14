// Example: using GenAI to call AI models from many vendors

// Model selection now uses the canonical "vendor:model:thinking" format.
// Example: openai:gpt-5.1:medium or anthropic:claude-sonnet-4-5-20250929:high.

import { GenAI } from './GenAI';

async function main(): Promise<void> {
  const ai = await GenAI("openai:gpt-5.1:medium");
  await ai.ask("Hello, world!", {});
}

main();
