// Inline files
// ============
// In a user message, `///<path>///` stands for that file, a pdf or an image,
// sent to the model as a native file part at that spot. The path is relative
// to the working dir. History keeps the message as typed; each request reads
// the file again and builds the vendor's parts, so every vendor sees the same
// thing. A message without a mark goes out as plain text, unchanged.

import * as fs from 'fs';
import * as path from 'path';

const MARK = /\/\/\/(\S+?\.(?:pdf|png|jpe?g|gif|webp))\/\/\//gi;

const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

type Part =
  | { text: string }
  | { name: string; mime: string; data: string };

export type Format = 'anthropic' | 'chat' | 'responses' | 'google';

function parts(text: string): Part[] {
  const out: Part[] = [];
  let at = 0;
  for (const m of text.matchAll(MARK)) {
    const file = path.resolve(m[1]);
    let data: string;
    try {
      data = fs.readFileSync(file).toString('base64');
    } catch {
      throw new Error(`inline file not found: ${file}`);
    }
    out.push({ text: text.slice(at, m.index) });
    out.push({ name: path.basename(file), mime: MIME[path.extname(file).slice(1).toLowerCase()], data });
    at = m.index! + m[0].length;
  }
  out.push({ text: text.slice(at) });
  return out.filter((p) => !('text' in p) || p.text.length > 0);
}

function wire_part(p: Part, fmt: Format): any {
  if ('text' in p) {
    switch (fmt) {
      case 'anthropic': return { type: 'text', text: p.text };
      case 'chat':      return { type: 'text', text: p.text };
      case 'responses': return { type: 'input_text', text: p.text };
      case 'google':    return { text: p.text };
    }
  }
  const pdf = p.mime === 'application/pdf';
  const url = `data:${p.mime};base64,${p.data}`;
  switch (fmt) {
    case 'anthropic': return { type: pdf ? 'document' : 'image', source: { type: 'base64', media_type: p.mime, data: p.data } };
    case 'chat':      return pdf ? { type: 'file', file: { filename: p.name, file_data: url } } : { type: 'image_url', image_url: { url } };
    case 'responses': return pdf ? { type: 'input_file', filename: p.name, file_data: url } : { type: 'input_image', image_url: url };
    case 'google':    return { inlineData: { mimeType: p.mime, data: p.data } };
  }
}

// The content of a user message in a vendor's format: the text itself when it
// has no mark (as a one-part list for formats whose content is always a list),
// else the list of its text and file parts.
export function wire(text: string, fmt: Format): any {
  if (!text.match(MARK)) {
    return fmt === 'anthropic' || fmt === 'chat' ? text : [wire_part({ text }, fmt)];
  }
  return parts(text).map((p) => wire_part(p, fmt));
}

// A message list with each typed user message in a vendor's format.
export function wire_msgs(messages: any[], fmt: Format): any[] {
  return messages.map((m) =>
    m.role === 'user' && typeof m.content === 'string' ? { ...m, content: wire(m.content, fmt) } : m);
}
