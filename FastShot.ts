//./../../../.AGENTS.md//
//./GenAI.ts//
//./Shot.ts//
//./ChatSH.ts//

our goal is to use GenAI.ts to create a new coding tool, named CodeBender. it
will be inspired on Claude Code and Codex CLI, but will be lighter, and work
differently. the TUI will have two parts:

- the chat: where messages from the AI, user and system are displayed. this is
  literally just the terminal, no special treatment at all.

- the input: this is a text area that is displayed at the bottom of the screen.
  unlike ChatSH, it is always on. also, it is displayed as N rows, with a light
  gray color as the background. as the user types, the text is inserted. if the
  user presses arrow keys, they can navigate on that text area. backspace
  removes a character. when the user presses shift+enter, they input a line
  break. when the user presses enter, the message is sent to the AI.

unlike Claude Code and Codex CLI, CodeBender maintains a persistent *context* of
all the files the AI can see. that context is displayed in a tree-like format,
and is expansible. for example, suppose that we have the following directory:

```
./demo._
my Demo project

./demo/A._
the A module

./demo/A/foo._
the foo function

./demo/A/foo.js
function foo(x) {
  return x * 2;
}

./demo/A/bar._
the bar function

./demo/A/bar.js
function bar(x) {
  return x + 1;
}

./demo/B._
the B module

./demo/B/foo._
the foo function

./demo/B/foo.js
function foo(x) {
  return x * 3;
}

./demo/B/bar._
the bar function

./demo/B/bar.js
function bar(x) {
  return x - 1;
}

./demo/C._
the C module

./demo/C/foo._
the foo function

./demo/C/foo.js
function foo(x) {
  return x * 7;
}

./demo/C/bar._
the bar function

./demo/C/bar.js
function bar(x) {
  return x - 3;
}
```

when almost fully expanded, this would be rendered like this:

 + demo/ # my Demo project
 . + A/ # the A module
 . . + foo.js # the foo function
 . . + bar.js # the bar function
 . + B/ # the B module
 . . + foo.js # the foo function
 . . - bar.js # the bar function
 . - C/ # the C module

./demo/A/foo.js
function foo(x) {
  return x * 2;
}

./demo/A/bar.js
function bar(x) {
  return x + 1;
}

./demo/B/foo.js
function foo(x) {
  return x * 3;
}

./demo/B/bar.js
function bar(x) {
  return x - 1;
}

the `._` files provide a short, one-line description for a file/dir.

on each inference call, we assemble a prompt to the AI, as follows:

TREE:

<<dir-tree>>

FILES:

<<file-list>>


<view>
./path/to/file
./path/to/file
./path/to/file
</view>

<hide>

<write path="./path/to/file">
file contents here
</write>

































