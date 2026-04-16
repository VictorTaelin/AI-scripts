#!/usr/bin/env node

// Polyfill SlowBuffer for Node.js v25+ (removed upstream, needed by jwa dep)
const buffer = require('buffer');
if (!buffer.SlowBuffer) {
  buffer.SlowBuffer = function(n) { return Buffer.allocUnsafe(n); };
  buffer.SlowBuffer.prototype = Buffer.prototype;
}

const { AskAI, tokenCount } = require('../dist/askai/AskAI');
const fs   = require('fs');
const path = require('path');

// ── Models ──────────────────────────────────────────────────────────────────
const MODELS = [
  { name: 'Opus 4.6',              spec: 'anthropic:claude-opus-4-6:low',              pricing: { input: 5.00, output: 25.00 } },
  { name: 'Opus 4.6 (fast)',       spec: 'anthropic:claude-opus-4-6:low:fast',         pricing: { input: 30.00, output: 150.00 } },
  { name: 'GPT 5.4',               spec: 'openai:gpt-5.4:low',                         pricing: { input: 2.50, output: 15.00 } },
  { name: 'GPT 5.4 (fast)',        spec: 'openai:gpt-5.4:low:fast',                    pricing: { input: 5.00, output: 30.00 } },
  { name: 'GPT 5.4 mini',          spec: 'openai:gpt-5.4-mini:low',                    pricing: { input: 0.75, output: 4.50 } },
  { name: 'GPT 5.4 mini (fast)',   spec: 'openai:gpt-5.4-mini:low:fast',               pricing: null },
  { name: 'GPT Codex 5.3',         spec: 'openai:gpt-5.3-codex:low',                   pricing: { input: 1.75, output: 14.00 } },
  { name: 'GPT Codex 5.3 (fast)',  spec: 'openai:gpt-5.3-codex:low:fast',              pricing: { input: 3.50, output: 28.00 } },
  { name: 'Gemini 3.1 Pro',        spec: 'google:gemini-3.1-pro-preview:low',          pricing: { input: 1.00, output: 6.00 } },
  { name: 'Gemini 3.1 Flash-Lite', spec: 'google:gemini-3.1-flash-lite-preview:low',   pricing: { input: 0.25, output: 1.50 } },
];

// ── Prompt ──────────────────────────────────────────────────────────────────
const sourceFile = path.join(__dirname, '..', 'loren.txt');
const sourceText = fs.readFileSync(sourceFile, 'utf8');
const PROMPT = `Translate the following text to Brazilian Portuguese (pt-BR). Output only the translation, nothing else.\n\n${sourceText}`;

// ── Output dir ──────────────────────────────────────────────────────────────
const outDir = path.join(__dirname, 'outputs');
fs.mkdirSync(outDir, { recursive: true });

// ── Helpers ─────────────────────────────────────────────────────────────────
function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
}

function hrMs(start) {
  const [s, ns] = process.hrtime(start);
  return s * 1000 + ns / 1e6;
}

function formatUsd(value) {
  return `$${value.toFixed(2)}`;
}

function formatPricing(pricing) {
  if (!pricing) {
    return { input: '—', output: '—' };
  }
  return {
    input: formatUsd(pricing.input),
    output: formatUsd(pricing.output),
  };
}

function computeHourlyCost(tokens, seconds, pricePerMTok) {
  if (typeof pricePerMTok !== 'number' || !Number.isFinite(pricePerMTok) || seconds <= 0) {
    return null;
  }
  return (tokens * 3600 * pricePerMTok) / (seconds * 1_000_000);
}

function formatHourlyCost(costs) {
  if (!costs || costs.input == null || costs.output == null || costs.total == null) {
    return { input: '—', output: '—' };
  }
  return {
    input: formatUsd(costs.input),
    output: formatUsd(costs.output),
  };
}

const origStdoutWrite = process.stdout.write.bind(process.stdout);
let stdoutSuppressCount = 0;

function acquireStdoutSuppression() {
  if (stdoutSuppressCount === 0) {
    process.stdout.write = () => true;
  }
  stdoutSuppressCount += 1;
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    stdoutSuppressCount = Math.max(0, stdoutSuppressCount - 1);
    if (stdoutSuppressCount === 0) {
      process.stdout.write = origStdoutWrite;
    }
  };
}

// ── Run one model ───────────────────────────────────────────────────────────
async function runModel(model) {
  // Init client outside of timing (key loading, client construction)
  let chat;
  try {
    chat = await AskAI(model.spec);
  } catch (err) {
    return { name: model.name, error: `init: ${err.message}` };
  }

  const inputTokens = tokenCount(PROMPT);

  // Suppress stdout from vendor streaming writes across all parallel runs.
  const releaseStdout = acquireStdoutSuppression();

  const t0 = process.hrtime();
  let output = '';
  let error = null;

  try {
    const result = await chat.ask(PROMPT, { stream: true });
    output = typeof result === 'string' ? result : '';
  } catch (err) {
    error = err.message?.slice(0, 120);
  } finally {
    releaseStdout();
  }

  const elapsedMs = hrMs(t0);

  if (error) {
    return { name: model.name, error };
  }

  const outputTokens = tokenCount(output);
  const elapsedS     = elapsedMs / 1000;
  const hourlyCost = model.pricing
    ? {
        input: computeHourlyCost(inputTokens, elapsedS, model.pricing.input),
        output: computeHourlyCost(outputTokens, elapsedS, model.pricing.output),
        total: computeHourlyCost(inputTokens, elapsedS, model.pricing.input)
          + computeHourlyCost(outputTokens, elapsedS, model.pricing.output),
      }
    : null;

  // Save translation to file
  const outFile = path.join(outDir, `${slug(model.name)}.txt`);
  fs.writeFileSync(outFile, output, 'utf8');

  return {
    name: model.name,
    timeS: elapsedS,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    pricing: model.pricing,
    hourlyCost,
    outFile: path.relative(process.cwd(), outFile),
  };
}

// ── Table printing ──────────────────────────────────────────────────────────
function printTable(results) {
  const hdr = ['Model', 'Time', 'Toks', 'In $/MTok', 'Out $/MTok', 'In $/h', 'Out $/h', 'Status'];

  const rows = results.map(r => {
    if (r.error) {
      return [r.name, '—', '—', '—', '—', '—', '—', `ERR: ${r.error.slice(0, 50)}`];
    }
    const pricing = formatPricing(r.pricing);
    const hourly = formatHourlyCost(r.hourlyCost);
    return [
      r.name,
      r.timeS.toFixed(2),
      String(r.totalTokens),
      pricing.input,
      pricing.output,
      hourly.input,
      hourly.output,
      '✓',
    ];
  });

  const widths = hdr.map((h, i) =>
    Math.max(h.length, ...rows.map(r => r[i].length))
  );

  const fmt = cols => cols.map((c, i) => ` ${c.padEnd(widths[i])} `).join('│');
  const sep = widths.map(w => '─'.repeat(w + 2)).join('┼');

  console.log();
  console.log(fmt(hdr));
  console.log(sep);
  rows.forEach(r => console.log(fmt(r)));
  console.log();
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Source: ${sourceFile}`);
  console.log(`Prompt tokens: ${tokenCount(PROMPT)}`);
  console.log(`Models: ${MODELS.length}`);
  console.log(`Running all in parallel...\n`);

  const wallStart = process.hrtime();
  const results = await Promise.all(MODELS.map(m => runModel(m)));
  const wallMs = hrMs(wallStart);

  printTable(results);

  console.log(`Wall clock (parallel): ${(wallMs / 1000).toFixed(2)}s`);

  const ok = results.filter(r => !r.error);
  if (ok.length > 0) {
    console.log(`Translations saved to: ${outDir}/`);
  }

  // Also dump raw JSON for further analysis
  const jsonFile = path.join(__dirname, 'results.json');
  fs.writeFileSync(jsonFile, JSON.stringify(results, null, 2));
  console.log(`Raw results: ${jsonFile}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
