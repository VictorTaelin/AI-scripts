// Polyfill SlowBuffer for Node.js v25+ (removed upstream, needed by jwa dep)
const buffer = require('buffer');
if (!buffer.SlowBuffer) {
  const B = Buffer;
  buffer.SlowBuffer = function SlowBuffer(n) { return B.allocUnsafe(n); };
  buffer.SlowBuffer.prototype = B.prototype;
}

const { AskAI, tokenCount } = require('./dist/askai/AskAI');
const fs = require('fs');

const text = fs.readFileSync('loren.txt', 'utf8');

const models = [
  { name: 'Opus 4.7',              spec: 'anthropic:claude-opus-4-7:low' },
  { name: 'Opus 4.7 (fast)',       spec: 'anthropic:claude-opus-4-7:low:fast' },
  { name: 'GPT 5.4',               spec: 'openai:gpt-5.4:low' },
  { name: 'GPT 5.4 (fast)',        spec: 'openai:gpt-5.4:low:fast' },
  { name: 'GPT Codex 5.3',         spec: 'openai:gpt-5.3-codex:low' },
  { name: 'GPT Codex 5.3 (fast)',  spec: 'openai:gpt-5.3-codex:low:fast' },
  { name: 'Gemini 3.1 Pro',        spec: 'google:gemini-3.1-pro-preview:low' },
];

const prompt = `Translate the following text to Brazilian Portuguese (pt-BR). Output only the translation, nothing else.\n\n${text}`;
const inputTokens = tokenCount(prompt);

async function runModel(model) {
  const start = Date.now();
  try {
    const chat = await AskAI(model.spec);
    const result = await chat.ask(prompt, { stream: true });
    const elapsed = (Date.now() - start) / 1000;
    const output = typeof result === 'string' ? result : '';
    const outTok = tokenCount(output);
    return {
      name: model.name,
      time: elapsed.toFixed(1),
      inputTokens,
      outputTokens: outTok,
      totalTokens: inputTokens + outTok,
      tokPerSec: (outTok / elapsed).toFixed(1),
      error: null,
    };
  } catch (err) {
    return {
      name: model.name,
      time: ((Date.now() - start) / 1000).toFixed(1),
      inputTokens: 0, outputTokens: 0, totalTokens: 0, tokPerSec: '—',
      error: err.message?.slice(0, 80),
    };
  }
}

async function main() {
  // Suppress vendor stdout writes
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;

  const results = await Promise.all(models.map(m => runModel(m)));

  // Restore stdout
  process.stdout.write = origWrite;

  // Table
  const hdr = ['Model', 'Time (s)', 'In Tok', 'Out Tok', 'Total Tok', 'Tok/s', 'Error'];
  const rows = results.map(r => [
    r.name, r.time, String(r.inputTokens), String(r.outputTokens),
    String(r.totalTokens), r.tokPerSec, r.error || '—',
  ]);
  const widths = hdr.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)));
  const sep = widths.map(w => '─'.repeat(w + 2)).join('┼');
  const fmt = (cols) => cols.map((c, i) => (' ' + c.padEnd(widths[i]) + ' ')).join('│');

  console.log(fmt(hdr));
  console.log(sep);
  rows.forEach(r => console.log(fmt(r)));
}

main().catch(err => {
  process.stdout.write = process.stderr.write.bind(process.stderr);
  console.error(err);
  process.exit(1);
});
