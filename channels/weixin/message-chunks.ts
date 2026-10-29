/** Keep paragraph/line boundaries and Unicode code points intact when possible. */
export function splitReply(text: string, limit = 1600): string[] {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('Invalid message limit');
  const points = Array.from(text);
  const chunks: string[] = [];
  let offset = 0;
  while (offset < points.length) {
    let end = Math.min(offset + limit, points.length);
    if (end < points.length) {
      let paragraph = -1;
      let line = -1;
      for (let i = offset; i < end; i++) {
        if (points[i] === '\n') {
          line = i + 1;
          if (i > offset && points[i - 1] === '\n') paragraph = i + 1;
        }
      }
      if (paragraph >= offset + Math.floor(limit / 2) && paragraph > offset) end = paragraph;
      else if (line > offset) end = line;
    }
    chunks.push(points.slice(offset, end).join(''));
    offset = end;
  }
  return chunks;
}
