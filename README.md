Taelin AI Scripts
=================

Some AI scripts I use daily.

- `holefill`: I use it on VIM to fill code snippets

- `aiemu`: emulate any game on the terminal ([example](https://x.com/VictorTaelin/status/1790183986096116189))
 
- `chatsh`: like ChatGPT but in the terminal ([example chat](https://x.com/VictorTaelin/status/1655304645953089538)) ([example coding](https://x.com/VictorTaelin/status/1809290888356729002)) ([example refactor](https://x.com/VictorTaelin/status/1828893898594300220))

- `koder`: perform refactor requests ([example](https://x.com/VictorTaelin/status/1824489509146227192)) ([example](https://x.com/VictorTaelin/status/1811254153655558188))

- `agda2ts`: compile Agda to/from TypeScript ([example](https://x.com/VictorTaelin/status/1837256721850306746))

- `aoe`: refactor a huge codebase by auto-filtering chunks that need edit ([example](https://x.com/VictorTaelin/status/1873948475299111244))

For VIM integration, this is my messy [vimrc](https://github.com/VictorTaelin/OSX/blob/master/vimrc).
Use Sonnet to extract the relevant functions for you (:

This repo in general is kinda gambiarra. Opus-4 might clean it up

## Usage

Just `npm install -g` and run the given command the terminal.

You'll need to add Anthropic/OpenAI keys to a location. The CLI will inform where.

## Note

Most of this scripts will save a log to `~/.ai`. If you don't want this behavior, edit the scripts to suit your needs. (TODO: add a proper option.)

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

## LICENSE

Everything here is MIT-licensed.
