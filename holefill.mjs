#!/usr/bin/env node

import * as GPT from './GPT.mjs';
import process from "process";
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const system = `
You are a HOLE FILLER. You are provided with a file containing holes, formatted
as '{{HOLE}}'. Your TASK is to answer with a string to replace this hole with.

#################

## EXAMPLE QUERY:

function sum_evens(lim) {
  var sum = 0;
  for (var i = 0; i < lim; ++i) {
    {{LOOP}}
  }
  return sum;
}

TASK: Fill the {{LOOP}} hole.

## CORRECT ANSWER:

if (i % 2 === 0) {
      sum += i;
    }

## NOTICE THE IDENTATION.
## The first line isn't idented, because the hole already has spaces before it.
## The other lines are idented, to match the surrounding style.

#################

## EXAMPLE QUERY:

function factorial(N) {
  var fact = 1;
  for (var i = 1; i <= N; ++i) {
{{LOOP}}
  }
  return fact;
}

TASK: Fill the {{LOOP}} hole.

## CORRECT ANSWER:

    fact *= i;

## NOTICE THE IDENTATION.
## ALL lines are idented, because there are no spaces before the hole.

#################

## EXAMPLE QUERY:

Q: Which is the largest mammal?

A: {{ANSWER}}

TASK: Fill the {{ANSWER}} hole.

## CORRECT ANSWER: 

The blue whale.

## NOTICE THE IDENTATION.
## There is no identation, since this is an inline hole.
`;

var file = process.argv[2];
var fill = process.argv[3];
var fast = process.argv[4] === "--fast";

if (!file) {
  console.log("Usage: holefill <file> [<shortened_file>]");
  console.log("");
  console.log("This will replace all {{HOLES}} in <file>, using GPT-4.");
  console.log("A shortened file can be used to omit irrelevant parts.");
  process.exit();
}

var file_code = await fs.readFile(file, 'utf-8');
var fill_code = fill ? await fs.readFile(fill, 'utf-8') : file_code;
var tokens = GPT.token_count(fill_code);
var holes = fill_code.match(/{{\w+}}/g) || [];
var model = fast ? "gpt-4-0125-preview" : "gpt-4-0314";

console.log("holes_found:", holes);
console.log("token_count:", tokens);
console.log("model_label:", model);

for (let hole of holes) {
  console.log("next_filled: " + hole + "...");
  var prompt = fill_code + "\nTASK: Fill the {{"+hole+"}} hole.";
  var answer = await GPT.ask({system, prompt, model});
  file_code = file_code.replace(hole, answer);
}

await fs.writeFile(file, file_code, 'utf-8');
