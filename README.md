Taelin AI Scripts
=================

Some AI scripts I use daily.

- `holefill`: I use it on VIM to fill code snippets

- `aiemu`: emulate any game on the terminal ([example](https://x.com/VictorTaelin/status/1790183986096116189))

- `chatsh`: like ChatGPT but in the terminal ([example / chatting](https://x.com/VictorTaelin/status/1655304645953089538)) ([example / intense coding](https://x.com/VictorTaelin/status/1809290888356729002))

- `tscoder`: perform TypeScript refactor requests ([example](https://x.com/VictorTaelin/status/1824489509146227192))

- `kindcoder`: perform Kind refactor requests ([example](https://x.com/VictorTaelin/status/1811254153655558188))

For VIM integration, this is my messy [vimrc](https://github.com/VictorTaelin/OSX/blob/master/vimrc).
Use Sonnet to extract the relevant functions for you (:

This repo in general is kinda gambiarra. Opus-4 might clean it up

## Usage

Just `npm install -g` and run the given command the terminal.

You'll need to add Anthropic/OpenAI keys to a location. The CLI will inform where.

## Using OpenRouter

To add [fzf](https://github.com/junegunn/fzf) completion for openrouter models, put this in .bashrc or similar:

```bash
_fzf_complete_chatsh() {
  _fzf_complete --multi --reverse --prompt="chatsh> " -- "$@" < <(
    curl -s https://openrouter.ai/api/v1/models | jq -r '.data[].id' | sed 's/^/openrouter:/'
  )
}
[ -n "$BASH" ] && complete -F _fzf_complete_chatsh -o default -o bashdefault chatsh

```

Then type:
```bash
$ chatsh **<tab>
```
