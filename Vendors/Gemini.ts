import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";
import { AskOptions, ChatInstance } from "../GenAI";

export class GeminiChat implements ChatInstance {
  private client: GoogleGenerativeAI;
  private model: string;
  private chatSession: any = null;
  private messages: { role: "user" | "assistant"; content: string }[] = [];
  private systemPrompt: string | null = null;

  constructor(apiKey: string, model: string) {
    this.client = new GoogleGenerativeAI(apiKey);
    this.model = model;
  }

  async ask(userMessage: string | null, options: AskOptions): Promise<string | { messages: any[] }> {
    if (userMessage === null) {
      return { messages: this.messages };
    }

    let { system, temperature = 0.0, max_tokens = 8192, stream = true } = options;

    // Prepend system prompt to user message if provided
    if (system) {
      userMessage = `System: ${system}\nUser: ${userMessage}`;
    }

    if (!this.chatSession) {
      const generationConfig = { maxOutputTokens: max_tokens, temperature };
      const safetySettings = [
        { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
      ];
      const history = this.messages.map(msg => ({ role: msg.role === "assistant" ? "model" : "user", parts: [{ text: msg.content }] }));
      this.chatSession = this.client.getGenerativeModel({ model: this.model, generationConfig }).startChat({
        safetySettings,
        history,
      });
    }

    this.messages.push({ role: "user", content: userMessage });
    let result = "";
    if (stream) {
      const response = await this.chatSession.sendMessageStream(userMessage);
      for await (const chunk of response.stream) {
        const text = chunk.text();
        process.stdout.write(text);
        result += text;
      }
      process.stdout.write("\n");
    } else {
      const response = await this.chatSession.sendMessage(userMessage);
      result = (await response.response).text();
    }
    this.messages.push({ role: "assistant", content: result });
    return result;
  }
}
