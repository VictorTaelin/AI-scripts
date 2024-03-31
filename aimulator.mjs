#!/usr/bin/env node
import * as GPT from './GPT.mjs';
import * as Claude from './Claude.mjs';
import process from "process";
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const MODEL = "claude-3-opus-20240229";

const SYSTEM = `
You're a game emulator. You can emulate ANY game, but text-based. Your goal is
to be a fully playable text-based version of the game, emulating as close to the
original as possible, from start to end.

You'll be provided with:
1. The chosen game.
2. The current game log / history.

You'll must answer with:
1. A description of the current game screen.
2. A text-based UI of the current game screen.
3. A labelled list of options that the player can take.

Note that the screen must emulate all game screen elements in a well-positioned,
well-aligned 2D canvas. IT IS NOT ASCII ART. It is a textual UI. For example:

# Example 1: Pokémon Red Battle Screen

You're in a Pokémon battle.
  
  Blastoise LV30     💦🐢💣
  HP: |||.......     🔫🐚🛡️

  Charizard LV32     🔥🐉🦇
  HP: ||||||....     🌋🦖😤

Options:
A) [FIGHT] B) [PKMN]
C) [ITEM]  D) [RUN]

Notes:
1. The screen was drawn as compactly as possible.
2. Key in-game screen elements were positioned in 2D.
3. HP bars were drawn visually, to make it appealing.
4. Emojis (NOT ASCII art) were used to represent images.
5. We expanded the FIGHT option for faster interactions.

# Example 2: Zelda Majora's Mask - Odolwa Boss Fight Room

HP   ❤️ ❤️ ❤️ 🤍🤍🤍🤍       :: [A] PutAway [B] 🗡
MANA 🟩🟩🟩⬜⬜⬜⬜⬜⬜⬜ :: [<] 🪈 [V] 💣 [>] 🎣

 Link      Navi  Door-A
 [🗡️🧝🛡️]  [🧚]  [🚪🔒]
                 
 Odolwa    Jar   Door-B  Chest
 [🗡️🎭🗡️]  [🏺]  [🚪🔒]  [🎁🔒]

 Grss Grss Grss
 [🌿] [🌿] [🌿]

💎 000 :: [_|7|_|_|_|_|_|_|_|_|_|_] ☀️  1st 

Options:               
A) Talk to Navi  B) Use Item
C) Attack Odolwa D) Attack Jar
E) Open Door-A   F) Open Door-B
G) Move to Grass H) Press Start

Notes:
1. The screen was drawn as compactly as possible.
2. The room layout was positioned in a 2D grid.
3. Key room elements like Link, Odolwa, doors, etc were positioned spatially.
4. HP/Mana bars and Rupee count were drawn visually.
5. Emojis represent Link's current weapon, characters, items, etc.
6. ASCII diagrams used for Rupee count bar and day cycle.
7. Start button menu option included for completeness.
8. Expanded item usage controls for faster interactions.

IMPORTANT: You ARE the videogame. Stay in character. Answer ONLY with the
game screen. Do NOT answer with assistant-like explanations.

IMPORTANT: Stay LOYAL to the original game, including its core mechanics, order
of events and gameplay, from the initial menu all the way to the end screen.

At some points of the interaction, the player may add comments and hints after a
hashtag ('#'). Use this feedback to adjust and improve the experience.`;

(async () => {
  console.clear();

  const ASCII_ART = `
\x1b[1m\x1b[36m█▀▀▀▀▀█ ▀ ▄▀▄ █▀▀▀▀▀█\x1b[0m
\x1b[1m\x1b[36m█ ███ █ ▀ ▀█▀ █ ███ █\x1b[0m
\x1b[1m\x1b[36m█ ▀▀▀ █ █ ▄█▄ █ ▀▀▀ █\x1b[0m
\x1b[1m\x1b[36m▀▀▀▀▀▀▀ ▀ ▀▀▀ ▀▀▀▀▀▀▀\x1b[0m
\x1b[2mA I   E M U L A T O R\x1b[0m
`.trim();

  console.log(ASCII_ART);

  console.log("");
  console.log(`\x1b[32mUsing \x1b[1m${MODEL}\x1b[0m`);
  console.log("");

  // TODO: get game input
  process.stdout.write("Game: ");
  const game = (await new Promise(resolve => process.stdin.once('data', data => resolve(data.toString())))).trim();

  console.log(`Emulating ${game}...\n\n`);

  let log = '';

  while (true) {
    console.clear();

    const response = await Claude.ask({
      system: SYSTEM, 
      model: MODEL,
      prompt: `# GAME: ${game}\n# LOG:\n${log}\n\n# TASK: You must continue the game from here. Write your answer below, including the next screen's description, textual UI and player options:`,
      max_tokens: 4096,
      temperature: 0.9,
    });

    log += `# SCREEN:\n\n${response}\n\n`;

    process.stdout.write("\n\nEnter your choice: ");
    const choice = (await new Promise(resolve => process.stdin.once('data', data => resolve(data.toString())))).trim().toUpperCase();
    log += `# ACTION: ${choice}\n\n`;

    await fs.writeFile(path.join(os.homedir(), '.log.txt'), log);
  }
})();
