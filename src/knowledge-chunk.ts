export type KnowledgeChunk = { section: string; content: string };
export type ChunkOptions = { maxChars?: number; overlapChars?: number };

// Markdown headings define boundaries. Paragraphs are kept together when possible.
export function chunkMarkdown(markdown: string, options: ChunkOptions = {}): KnowledgeChunk[] {
  const maxChars = options.maxChars ?? 1200;
  const overlapChars = options.overlapChars ?? 160;
  if (!Number.isInteger(maxChars) || maxChars < 200 || maxChars > 8000) {
    throw new Error('maxChars must be an integer between 200 and 8000');
  }
  if (!Number.isInteger(overlapChars) || overlapChars < 0 || overlapChars >= maxChars / 2) {
    throw new Error('overlapChars must be a nonnegative integer smaller than half maxChars');
  }

  const sections: { name: string; lines: string[] }[] = [{ name: 'Overview', lines: [] }];
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) sections.push({ name: heading[1]!.trim(), lines: [] });
    else sections.at(-1)!.lines.push(line);
  }

  const result: KnowledgeChunk[] = [];
  for (const section of sections) {
    const paragraphs = section.lines.join('\n').trim().split(/\n\s*\n/)
      .map(value => value.replace(/\s+/g, ' ').trim()).filter(Boolean);
    let current = '';
    const emit = () => {
      if (current) result.push({ section: section.name, content: current });
    };
    for (const paragraph of paragraphs) {
      for (const piece of splitLong(paragraph, maxChars - overlapChars - 2)) {
        if (current && current.length + 2 + piece.length > maxChars) {
          emit();
          const tail = overlapChars ? current.slice(-overlapChars).replace(/^\S*\s/, '').trim() : '';
          current = tail && tail.length + 2 + piece.length <= maxChars ? tail : '';
        }
        current = current ? `${current}\n\n${piece}` : piece;
      }
    }
    emit();
  }
  return result;
}

function splitLong(text: string, limit: number): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const space = rest.lastIndexOf(' ', limit);
    const end = space > limit / 2 ? space : limit;
    pieces.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trimStart();
  }
  if (rest) pieces.push(rest);
  return pieces;
}
