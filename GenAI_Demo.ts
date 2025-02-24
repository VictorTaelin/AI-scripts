import { GenAI } from './GenAI';

async function main() {
  // Available models:
  // - g: GPT-4o
  // - c: Claude
  // - d: DeepSeek
  // - l: Llama
  // - i: Gemini
  // - x: Grok
  const ai = await GenAI("g");

  // Options
  const opts = {
    system: "You are a helpful assistant.",
    temperature: 0.0,
    stream: true,
  };

  // Send a message
  console.log(await ai.ask("Hello, how are you?", opts));

  // Send another message
  console.log(await ai.ask("What is my name?", opts));
}

main();
