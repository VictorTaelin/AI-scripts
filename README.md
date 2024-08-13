Taelin AI Scripts
=================

Some AI scripts I use daily.

- `holefill`: I use it on VIM to fill code snippets

- `aiemu`: moved to [here](https://github.com/victorTaelin/aiemu)

- `chatsh [model]`: like ChatGPT but in the terminal

TODO: remove `Claude.mjs`/`GPT.mjs` and just use `Ask.mjs` in all files


To add fzf completion for openrouter models, use this:
```bash
_fzf_complete_chatsh() {
  _fzf_complete --multi --reverse --prompt="chatsh> " -- "$@" < <(
    curl https://openrouter.ai/api/v1/models | jq -r '.data[].id' | sed 's/^/openrouter:/'
  )
}
[ -n "$BASH" ] && complete -F _fzf_complete_chatsh -o default -o bashdefault chatsh

```

TODO: Openrouter is still failing because code is not complete

- Add option, `--list-models` using https://nodejs.org/api/util.html#utilparseargsconfig
- Try using https://openrouter.ai/api/v1/models to list openrouter models
- Try using `chatsh --list-models | fzf | chatsh`
- ALT APPROACH: Just do something like:
  - curl https://openrouter.ai/api/v1/models | jq '.data[].id' | fzf | xargs chatsh
  - No need to add 'openrouter:' to the model name, like chatsh openrouter:<fzf selected model id here>
  - So the corrected command should be something like:
    - curl https://openrouter.ai/api/v1/models | jq '.data[].id' | fzf | sed 's/^/openrouter:/' | xargs chatsh
    - This could be turned into a fzf plugin like this:
Using this syntax that fzf supports:
```
# Custom fuzzy completion for "doge" command
#   e.g. doge **<TAB>
_fzf_complete_doge() {
  _fzf_complete --multi --reverse --prompt="doge> " -- "$@" < <(
    echo very
    echo wow
    echo such
    echo doge
  )
}
```
We should have this:
```
_fzf_complete_chatsh() {
  _fzf_complete --multi --reverse --prompt="chatsh> " -- "$@" < <(
    curl https://openrouter.ai/api/v1/models | jq '.data[].id' | sed 's/^/openrouter:/' | xargs
  )
}
```
