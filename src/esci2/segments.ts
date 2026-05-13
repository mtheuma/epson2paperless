/**
 * Split an ESC/I-2 INFO/CAPA body into "#" prefixed segments. Each segment
 * runs from a "#" byte to the byte before the next "#", or to end-of-buffer.
 */
export function splitHashSegments(body: Buffer): string[] {
  const text = body.toString("ascii");
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "#") {
      i++;
      continue;
    }
    let end = i + 1;
    while (end < text.length && text[end] !== "#") end++;
    out.push(text.slice(i, end));
    i = end;
  }
  return out;
}
