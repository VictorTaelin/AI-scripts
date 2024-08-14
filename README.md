Taelin AI Scripts
=================

Some AI scripts I use daily.

- `holefill`: I use it on VIM to fill code snippets

- `aiemu`: moved to [here](https://github.com/victorTaelin/aiemu)

- `chatsh [model]`: like ChatGPT but in the terminal

TODO: remove `Claude.mjs`/`GPT.mjs` and just use `Ask.mjs` in all files


To add [fzf](https://github.com/junegunn/fzf) completion for openrouter models, put this in .bashrc or similar:
```bash
_fzf_complete_chatsh() {
  _fzf_complete --multi --reverse --prompt="chatsh> " -- "$@" < <(
    curl https://openrouter.ai/api/v1/models | jq -r '.data[].id' | sed 's/^/openrouter:/'
  )
}
[ -n "$BASH" ] && complete -F _fzf_complete_chatsh -o default -o bashdefault chatsh

```

Then type:
```bash
$ chatsh **<tab>
```
