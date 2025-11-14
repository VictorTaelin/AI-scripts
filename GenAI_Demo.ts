import { GenAI } from './GenAI';

async function main() {
  // Model specs follow the "vendor:model:thinking" format.
  const ai = await GenAI("openai:gpt-5.1:medium");

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
