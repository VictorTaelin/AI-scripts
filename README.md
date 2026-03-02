Taelin AI Scripts
=================

AI tools for daily coding workflows.

Structure
---------

- `./askai/` — unified AI interface (`AskAI`) and vendor implementations
- `./tools/` — CLI tools built on AskAI
- `./` — config files (`package.json`, `tsconfig.json`, etc.)

Tools
-----

- `csh` — terminal chat with shell execution ([example](https://x.com/VictorTaelin/status/1655304645953089538))
- `holefill` — fill `.?.` placeholders in code via AI
- `shot` — one-shot AI code editing with tool calls
- `refactor` — context-aware code refactoring with smart compaction
- `board` — multi-advisor panel for file review
- `long` — codex loop: goal → work → board review → repeat

Usage
-----

```bash
npm install -g
```

Then run any tool from the terminal (e.g. `csh s`, `holefill file.ts`).

API keys go in `~/.config/<vendor>.token` (e.g. `~/.config/openai.token`).

See `./askai/AskAI.md` for the AskAI library API reference.

License
-------

MIT
