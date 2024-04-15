#!/usr/bin/env node

import process from "process";
import OpenAI from "openai";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { encode } from "gpt-tokenizer/esm/model/davinci-codex"; // tokenizer

const openai = new OpenAI({apiKey: await get_token()});

export async function get_token() {
  const tokenPath = path.join(os.homedir(), ".config", "openai.token");
  try {
    const token = (await fs.readFile(tokenPath, "utf8")).trim();
    return token;
  } catch (err) {
    if (err.code === "ENOENT") {
      console.error("Error: openai.token file not found in `~/.config/openai.token`.");
      console.error("Please make sure the file exists and contains your OpenAI API token.");
    } else {
      console.error("Error reading openai.token file:", err.message);
    }
    process.exit(1);
  }
}

export async function ask({system, prompt, model, temperature}) {
  const stream = await openai.chat.completions.create({
    model: model || "gpt-4-turbo-2024-04-09",
    messages: [
      {role: "system", content: system || "You're a helpful assistant." },
      {role: "user", content: prompt || "What time is it?" }
    ],
    stream: true,
    temperature: temperature || 0,
  });
  var result = "";
  for await (const chunk of stream) {
    var text = chunk.choices[0]?.delta?.content || "";
    process.stdout.write(text);
    result += text;
  }
  process.stdout.write("\n");
  return result;
}

export function token_count(inputText) {
  // Encode the input string into tokens
  const tokens = encode(inputText);

  // Get the number of tokens
  const numberOfTokens = tokens.length;

  // Return the number of tokens
  return numberOfTokens;
}
