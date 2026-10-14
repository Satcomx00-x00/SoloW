/// <reference types="bun-types" />

import { join, resolve } from "node:path";
import { BACKUPS_DIR, BackupError, backupDataDir, listBackups, restoreDataDir } from "./backup.js";

/**
 * `backup`, `restore` and `list` for a data folder. One entry point for both launchers: the repo
 * runs it through `scripts/backup.sh`, the npm package bundles it as `dist/db/backup.js` and
 * `solow backup` / `solow restore` call it with `--data-dir`. Neither needs the database's secret
 * key or any other part of the stack's environment — a backup copies the key, it never uses it.
 */

const USAGE = `Usage:
  backup  [--data-dir <dir>] [--out <dir>] [--no-engine]
  restore <backup> [--data-dir <dir>]
  list    [--data-dir <dir>]

  --data-dir  The data folder (default $SOLOW_HOME)
  --out       Where to create the backup (default <data-dir>/backups)
  --no-engine Leave the engine's state (in-flight runs) out of the backup
  <backup>    A backup's directory, or its name as \`list\` prints it`;

interface Args {
  command: string;
  dataDir: string;
  out?: string;
  engine: boolean;
  positional: string[];
}

function parse(argv: string[]): Args {
  const [command = "", ...rest] = argv;
  const args: Args = {
    command,
    dataDir: process.env.SOLOW_HOME ?? "",
    engine: true,
    positional: [],
  };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    const value = () => {
      const v = rest[++i];
      if (v === undefined) throw new BackupError(`${arg} needs a value`);
      return v;
    };
    if (arg === "--data-dir") args.dataDir = value();
    else if (arg === "--out") args.out = value();
    else if (arg === "--no-engine") args.engine = false;
    else if (arg === "-h" || arg === "--help") args.command = "help";
    else if (arg.startsWith("-")) throw new BackupError(`unknown option: ${arg}\n\n${USAGE}`);
    else args.positional.push(arg);
  }
  if (args.command !== "help" && !args.dataDir) {
    throw new BackupError("no data folder: pass --data-dir or set SOLOW_HOME");
  }
  args.dataDir = resolve(args.dataDir);
  return args;
}

function printList(dataDir: string): void {
  const backups = listBackups(join(dataDir, BACKUPS_DIR));
  if (backups.length === 0) {
    console.log(`no backups in ${join(dataDir, BACKUPS_DIR)}`);
    return;
  }
  for (const { name, manifest } of backups) {
    const engine = manifest.engine ? "with engine state" : "database and keys";
    console.log(`  ${name.padEnd(36)} ${manifest.kind.padEnd(12)} ${engine}`);
  }
}

export function main(argv: string[]): number {
  const args = parse(argv);
  switch (args.command) {
    case "backup": {
      const path = backupDataDir(args.dataDir, { into: args.out, engine: args.engine });
      console.log(`backed up ${args.dataDir} to ${path}`);
      return 0;
    }
    case "restore": {
      const [ref] = args.positional;
      if (!ref) {
        console.error("restore needs a backup. Available:");
        printList(args.dataDir);
        return 1;
      }
      // Set by `scripts/backup.sh` and `solow restore`, which took the data folder's lock on a
      // descriptor this process inherited and holds until it exits.
      const result = restoreDataDir(args.dataDir, ref, {
        locked: process.env.SOLOW_DATA_DIR_LOCKED === "1",
      });
      console.log(`restored ${result.source} into ${args.dataDir}`);
      if (result.previous) console.log(`what was there before is in ${result.previous}`);
      if (!result.manifest.engine) {
        console.log(
          "this backup has no engine state: the engine's queue was left as it was, so a run it " +
            "still holds may resume against the restored database",
        );
      }
      return 0;
    }
    case "list":
      printList(args.dataDir);
      return 0;
    case "help":
      console.log(USAGE);
      return 0;
    default:
      console.error(USAGE);
      return 1;
  }
}

if (import.meta.main) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    if (error instanceof BackupError) {
      console.error(`solow: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}
