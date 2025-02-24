import { Scraper } from 'agent-twitter-client-taelin-fork';
import { AskOptions, ChatInstance } from "../GenAI";
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

export class GrokChat implements ChatInstance {
  private scraper: Scraper | null = null;
  private conversationId: string | null = null;
  private messages: { role: "user" | "assistant"; content: string }[] = [];
  private cookies: any[] | null = null;
  private model: string;
  private systemPrompt: string | null = null;

  constructor(model: string) {
    this.model = model;
  }

  private async initialize(): Promise<void> {
    if (!this.scraper) {
      const configPath = path.join(os.homedir(), '.config', 'twitter.pwd');
      let credentials;
      try {
        const data = await fs.readFile(configPath, 'utf8');
        credentials = JSON.parse(data);
      } catch (err) {
        console.error('Error reading twitter.pwd file:', (err as Error).message);
        throw new Error('Failed to load Twitter credentials');
      }

      const { user, pass, email } = credentials;
      if (!user || !pass) {
        throw new Error('twitter.pwd must contain "user" and "pass" fields');
      }

      this.scraper = new Scraper();

      const cookiesPath = path.join(os.homedir(), '.config', 'twitter.cookies');
      try {
        const cookiesData = await fs.readFile(cookiesPath, 'utf8');
        const cookieStrings = JSON.parse(cookiesData);
        const loadedCookies = cookieStrings.filter((cookie: any) => cookie !== undefined);
        await this.scraper.setCookies(loadedCookies);
      } catch (err) {
        this.cookies = null;
      }

      if (!(await this.scraper.isLoggedIn())) {
        try {
          await this.scraper.login(user, pass, email || undefined);
          this.cookies = await this.scraper.getCookies();
          const cookieStrings = this.cookies.map(cookie => cookie.toString());
          await fs.writeFile(cookiesPath, JSON.stringify(cookieStrings), 'utf8');
        } catch (err) {
          throw new Error('Twitter login failed');
        }
      }
    }
  }

  async ask(userMessage: string | null, options: AskOptions): Promise<string | { messages: any[] }> {
    if (userMessage === null) {
      return { messages: this.messages };
    }

    await this.initialize();

    let { system, stream = true } = options;

    // Prepend system prompt to user message if provided
    if (system) {
      userMessage = `${system}\n---\n${userMessage}`;
    }

    const messagesToSend: { role: "user" | "assistant"; content: string }[] = [{ role: 'user', content: userMessage }];

    try {
      const modelName = this.model.replace("-think", "");
      const isReasoning = this.model.endsWith("-think");
      const response = await this.scraper!.grokChat({
        messages: messagesToSend,
        conversationId: this.conversationId ?? undefined,
        isReasoning,
        returnSearchResults: false,
        returnCitations: false,
        stream,
        ...options,
      });
      process.stdout.write("\n");

      this.conversationId = response.conversationId;
      this.messages = response.messages;

      if (response.rateLimit?.isRateLimited) {
        console.warn(`Rate limit exceeded: ${response.rateLimit.message}`);
      }

      return response.message;
    } catch (err) {
      console.error('Error interacting with Grok:', (err as Error).message);
      throw err;
    }
  }
}
