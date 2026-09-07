/**
 * Splits one line typed the way a shell would read it into a command and its arguments.
 *
 * The MCP server form used to ask for the command in one field and "arguments, one per line"
 * in another, which is how the API stores them — but nobody thinks of `npx -y @scope/server`
 * as three things, and the README of every MCP server prints it as one line. So the form takes
 * the line and this does the splitting, with the three rules a shell applies that matter for
 * an argument list: whitespace separates, `'…'` and `"…"` keep a space inside one argument, and
 * a backslash outside single quotes escapes the next character. No variable expansion, no
 * globbing — the harness runtime spawns the command without a shell, so none of that would have
 * happened anyway, and a `$HOME` typed here should reach the server as typed.
 */
export type CommandLine = { command: string; args: string[] };

export function splitCommandLine(line: string): CommandLine | { error: string } {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === "\\" && quote === '"' && i + 1 < line.length) {
        word += line[++i];
      } else {
        word += ch;
      }
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
    } else if (ch === "\\" && i + 1 < line.length) {
      word += line[++i];
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
    } else {
      word += ch;
      inWord = true;
    }
  }
  if (quote) return { error: `An unclosed ${quote === "'" ? "single" : "double"} quote.` };
  if (inWord) words.push(word);
  const [command, ...args] = words;
  if (!command) return { error: "A command to run." };
  return { command, args };
}

/** The inverse: a line that would split back into the same command and arguments. */
export function joinCommandLine({ command, args }: CommandLine): string {
  return [command, ...args].map(quoteWord).join(" ");
}

function quoteWord(word: string): string {
  if (word !== "" && !/[\s'"\\]/.test(word)) return word;
  return `'${word.replaceAll("'", "'\\''")}'`;
}
