import { describe, expect, it } from "bun:test";
import { joinCommandLine, splitCommandLine } from "./command-line";

describe("splitCommandLine", () => {
  it("splits on whitespace, however much of it", () => {
    expect(splitCommandLine("  npx  -y\t@modelcontextprotocol/server-github ")).toEqual({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
    });
  });

  it("keeps a quoted space inside one argument, and drops the quotes", () => {
    expect(splitCommandLine(`node server.js --name "My Server" --dir '/tmp/a b'`)).toEqual({
      command: "node",
      args: ["server.js", "--name", "My Server", "--dir", "/tmp/a b"],
    });
    // Quotes glue to the word around them, the way a shell reads --flag="x y".
    expect(splitCommandLine(`cmd --flag="x y"`)).toEqual({ command: "cmd", args: ["--flag=x y"] });
  });

  it("reads a backslash as an escape outside single quotes", () => {
    expect(splitCommandLine(`cmd a\\ b "say \\"hi\\"" 'lit\\eral'`)).toEqual({
      command: "cmd",
      args: ["a b", 'say "hi"', "lit\\eral"],
    });
  });

  it("keeps an empty quoted argument, since the server may want one", () => {
    expect(splitCommandLine(`cmd "" x`)).toEqual({ command: "cmd", args: ["", "x"] });
  });

  it("does not expand anything: what is typed is what the server gets", () => {
    expect(splitCommandLine("cmd $HOME *.md")).toEqual({ command: "cmd", args: ["$HOME", "*.md"] });
  });

  it("says what is missing rather than guessing", () => {
    expect(splitCommandLine("   ")).toEqual({ error: "A command to run." });
    expect(splitCommandLine(`cmd "open`)).toEqual({ error: "An unclosed double quote." });
    expect(splitCommandLine("cmd 'open")).toEqual({ error: "An unclosed single quote." });
  });
});

describe("joinCommandLine", () => {
  it("round-trips through splitCommandLine, quoting only what needs it", () => {
    const cases = [
      { command: "npx", args: ["-y", "@scope/server"] },
      { command: "node", args: ["a b", "it's", 'say "hi"', "", "$HOME"] },
    ];
    for (const c of cases) expect(splitCommandLine(joinCommandLine(c))).toEqual(c);
    expect(joinCommandLine(cases[0]!)).toBe("npx -y @scope/server");
    expect(joinCommandLine({ command: "cmd", args: ["a b"] })).toBe("cmd 'a b'");
  });
});
