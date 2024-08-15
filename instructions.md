# How to configure AI-scripts 

To install all the scripts globally in your machine, simply:

`cd` untill you reach `AI-scripts` dir.
Run `npm install -g .`

Now you should be able to run any of the scripts specified on `package.json` `bin` section globally.

# How to configure refactor on vim

This is a vim configuration to use Kindcoder and Tscoder.

## Kindcoder, Tscoder and Refactor

```
" Refactors the file using AI
function! RefactorFile()
  let l:current_file = expand('%:p')
  call inputsave()
  let l:user_text = input('Enter refactor request: ')
  call inputrestore()
  
  " Save the file before refactoring
  write

  if expand('%:e') == 'kind2'
    let l:cmd = 'kindcoder "' . l:current_file . '" "' . l:user_text . '" s'
  elseif expand('%:e') == 'ts'
    let l:cmd = 'tscoder "' . l:current_file . '" "' . l:user_text . '" s'
  else
    let l:cmd = 'refactor "' . l:current_file . '" "' . l:user_text . '" s'
  endif
  
  " Add --check flag if user_text starts with '-' or is empty
  if l:user_text =~ '^-' || empty(l:user_text)
    let l:cmd .= ' --check'
  endif
  
  execute '!clear && ' . l:cmd
  edit!
endfunction

nnoremap <space> :call RefactorFile()<CR>
```

This snippet basically remaps pressing space in normal mode to call the refactor file function.
Assuming you have kindcoder and tscoder installed, it will:

- If the file is a .kind2 file, calls kindcoder to it.
- If it is a .ts file, use the tscoder on it
- Else, call the normal refactor command agnostic of language.



