/** Common fence rules shared by archival extraction and protocol recovery. */
export function markdownLines(text: string): { text: string; literal: boolean; fence: boolean }[] {
  let delimiter = "", width = 0, quoted = false;
  return text.split(/\r?\n/).map((line) => {
    if (delimiter) {
      const closing = line.match(/^ {0,3}(`+|~+)[ \t]*$/);
      const closes = closing?.[1][0] === delimiter && closing[1].length >= width;
      if (closes) { delimiter = ""; width = 0; }
      return { text: line, literal: true, fence: true };
    }
    if (!line.trim()) quoted = false;
    if (/^ {0,3}>/.test(line)) quoted = true;
    else if (/^ {0,3}(?:#{1,6}\s|`{3,}|~{3,}|[-+*]\s|1[.)]\s)/.test(line)) quoted = false;
    if (quoted) return { text: line, literal: true, fence: false };
    const opening = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (opening && !(opening[1][0] === "`" && opening[2].includes("`"))) {
      delimiter = opening[1][0]; width = opening[1].length;
      return { text: line, literal: true, fence: true };
    }
    return { text: line, literal: false, fence: false };
  });
}

/** Remove matched inline code spans; unmatched delimiters remain ordinary text. */
export function withoutInlineCode(text: string): string {
  const runs = [...text.matchAll(/`+/g)];
  const next = new Int32Array(runs.length).fill(-1), widths = new Map<number, number>();
  for (let i = runs.length - 1; i >= 0; i--) {
    next[i] = widths.get(runs[i][0].length) ?? -1;
    widths.set(runs[i][0].length, i);
  }
  let start = 0, result = "";
  for (let i = 0; i < runs.length; i++) {
    const closing = next[i];
    if (closing < 0) continue;
    result += text.slice(start, runs[i].index) + " ";
    start = runs[closing].index! + runs[closing][0].length;
    i = closing;
  }
  return result + text.slice(start);
}

export function protocolText(text: string): string {
  return withoutInlineCode(markdownLines(text)
    .filter((line) => !line.literal && !/^(?: {4}|\t)/.test(line.text))
    .map((line) => line.text).join("\n"));
}
