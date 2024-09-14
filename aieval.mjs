#!/usr/bin/env node

import { chat, MODELS } from './Chat.mjs';
import fs from 'fs/promises';
import path from 'path';

const GRADER = (intro, question, userAnswer, referenceAnswer) => `
# INTRODUCTION:

${intro}

# QUESTION:

${question}

# USER ANSWER:

(The answer below was given by the user, and may be incorrect.)

${userAnswer}

# REFERENCE ANSWER:

(The answer below is correct. Consider it the source of truth.)

${referenceAnswer}

# YOUR TASK:

Your goal is to evaluate the answer provided by the user, compare it to the
REFERENCE ANSWER, and then output a JSON result in the following format:

{
  "summary": "<an 1-line summary of the user's answer, including its reasoning>",
  "score": <score (either 1 if user gave a correct answer, or 0 otherwise)>
}

Review the user's ANSWER carefully, check it against the REFERENCE, and reply
with the JSON result. REMEMBER: make sure to give a score to the user based on
whether the USER ANSWER matches the REFERENCE ANSWER. Do not use your own judgement.
Just take the REFERENCE ANSWER as the source of truth.

Answer with just a JSON, and nothing else.
`;

async function main() {
  if (process.argv.length < 3) {
    console.log("Usage: aieval <path_to_test_file> [<model_name>] [<number_of_runs>]");
    console.log("The test file should contain an introduction followed by questions in #Q<N>: format");
    process.exit(1);
  }

  const fpath = process.argv[2];
  const model = process.argv[3] || 'c';
  const numRuns = parseInt(process.argv[4]) || 1;

  console.log("AI-EVAL");
  console.log("test  : " + fpath);
  console.log("model : " + (MODELS[model] || model));
  console.log("runs  : " + numRuns);
  console.log("");

  try {
    const file = await fs.readFile(fpath, 'utf-8');
    
    const parts = file.split(/(?=#Q)/);
    const intro = parts[0].trim();
    const rest = parts.slice(1).join('\n');

    const questions = rest.match(/#Q\d+:.+/g) || [];
    const answers = rest.match(/#A\d+:.+/g) || [];

    for (let run = 0; run < numRuns; run++) {
      console.log(`Run ${run} of ${numRuns}`);
      let result = '';

      // Create a single long-lasting chat session
      const ask = chat(model);

      // Present the introduction
      console.log(intro);
      const introResponse = await ask(intro, { model: model });
      console.log("\n");
      result += `${intro}\n\n${introResponse}\n\n`;

      // Ask each question independently
      for (let i = 0; i < questions.length; i++) {
        console.log(`${questions[i]}\n`);
        const response = await ask(questions[i], { model: model });
        console.log("\n");
        result += `${questions[i]}\n\n${response}\n\n`;
      }

      // Save the initial result
      const fullModelName = MODELS[model] || model;
      const resultDir = path.join('./result', `run_${run}`);
      await fs.mkdir(resultDir, { recursive: true });
      const resultPath = path.join(resultDir, `${fullModelName.replace("/","_")}.txt`);
      await fs.writeFile(resultPath, result);
      console.log(`Initial result saved to ${resultPath}`);

      // Grade each answer individually
      const gradeAsk = chat('c');
      let totalScore = 0;
      let gradingResult = '';

      for (let i = 0; i < questions.length; i++) {
        const userAnswer = result.split(questions[i])[1].split(/#Q\d+:|$/, 1)[0].trim();
        const gradingPrompt = GRADER(intro, questions[i], userAnswer, answers[i]);
        const gradingResponse = await gradeAsk(gradingPrompt, { model: 'c' });
        console.log("\n");
        
        // Extract JSON from the response
        const jsonStart = gradingResponse.indexOf('{');
        const jsonEnd = gradingResponse.lastIndexOf('}') + 1;
        const jsonString = gradingResponse.slice(jsonStart, jsonEnd);
        
        let gradingJson;
        try {
          gradingJson = JSON.parse(jsonString);
        } catch (error) {
          console.error(`Error parsing JSON for question ${i}:`, error);
          gradingJson = { summary: "Error parsing grader response", score: 0 };
        }

        totalScore += gradingJson.score;
        gradingResult += `- Q${i}: ${questions[i].replace('#Q' + i + ':', '').trim()}\n`;
        gradingResult += `- A${i}: ${answers[i].replace('#A' + i + ':', '').trim()}\n`;
        gradingResult += `- J${i}: ${gradingJson.summary}\n`;
        gradingResult += `- S${i}: ${gradingJson.score}\n\n`;
      }

      gradingResult += `SCORE: ${totalScore}/${questions.length}\n`;

      // Append grading to the result
      result += "\n\nRESULT:\n\n" + gradingResult;

      // Save the final result with grading
      await fs.writeFile(resultPath, result);
      console.log(`Final result with grading saved to ${resultPath}`);
    }

  } catch (error) {
    console.error("Error:", error.message);
    process.exit(1);
  }
}

main().catch(console.error);
