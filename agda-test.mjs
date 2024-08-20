// File: agda-test.mjs

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const testDir = './agda-test';

// Helper function to create test files
function createTestFile(filename, content) {
  const filePath = path.join(testDir, filename);
  fs.writeFileSync(filePath, content);
}

// Helper function to run agda-deps and get output
function runAgdaDeps(filename) {
  const output = execSync(`node agda-deps.mjs ${path.join(testDir, filename)}`).toString().trim();
  return output.split('\n');
}

// Test 1: Different import syntaxes
createTestFile('Test1.agda', `
module Test1 where

import Data.Nat
open import Data.Bool
import Data.List as List
open import Data.Maybe using (Maybe; just; nothing)
open Data.String using ()
`);

console.log("Test 1: Different import syntaxes");
const test1Result = runAgdaDeps('Test1.agda');
console.log(test1Result);
console.log();

// Test 2: Circular imports
createTestFile('CircularA.agda', `
module CircularA where

import CircularB
`);

createTestFile('CircularB.agda', `
module CircularB where

import CircularA
`);

console.log("Test 2: Circular imports");
const test2Result = runAgdaDeps('CircularA.agda');
console.log(test2Result);
console.log();

// Test 3: Indirect dependencies
createTestFile('Main.agda', `
module Main where

import IndirectA
`);

createTestFile('IndirectA.agda', `
module IndirectA where

import IndirectB
`);

createTestFile('IndirectB.agda', `
module IndirectB where

import Data.Nat
`);

console.log("Test 3: Indirect dependencies");
const test3Result = runAgdaDeps('Main.agda');
console.log(test3Result);
console.log();

// Test 4: Multi-line imports
createTestFile('MultiLine.agda', `
module MultiLine where

open import Data.List using (
  List; []; 
  _∷_
)
`);

console.log("Test 4: Multi-line imports");
const test4Result = runAgdaDeps('MultiLine.agda');
console.log(test4Result);
console.log();

// Test 5: Renaming imports
createTestFile('Renaming.agda', `
module Renaming where

import Data.Nat as N
open import Data.Bool as B using (Bool; true; false)
`);

console.log("Test 5: Renaming imports");
const test5Result = runAgdaDeps('Renaming.agda');
console.log(test5Result);
console.log();

// Clean up test files
fs.readdirSync(testDir).forEach(file => fs.unlinkSync(path.join(testDir, file)));
