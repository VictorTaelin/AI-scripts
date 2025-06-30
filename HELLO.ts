// Example: using GenAI to call AI models from many vendors

// Model Shortcuts:
// g  : OpenAI GPT-series (small)
// G  : OpenAI GPT-series (big)
// o  : OpenAI o-series (small)
// O  : OpenAI O-series (big)
// c  : Anthropic Sonnet
// C  : Anthropic Opus
// ct : Anthropic Sonnet (thinking on)
// Ct : Anthropic Sonnet (thinking on)
// i  : Google Gemini Flash
// I  : Google Gemini Pro
// x  : X Grok
// xt : X Grok (thinking on)

import { GenAI, MODELS, tokenCount, AskOptions } from './GenAI';

async function main() : Promise<void> {
  const ai = await GenAI("g");
  console.log("MODEL: " + (ai as any).model)
  await ai.ask("Hello, world!", {});
};

main();
