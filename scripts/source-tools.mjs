import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const workspace = process.env.GITHUB_WORKSPACE;
const output = process.env.GITHUB_OUTPUT;
if (!workspace || !output) throw new Error("Missing tool version context.");

const manifest = JSON.parse(
  readFileSync(join(workspace, "src/package.json"), "utf8"),
);
const pnpm = /^pnpm@((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(
  typeof manifest.packageManager === "string" ? manifest.packageManager : "",
)?.[1];
const directives = readFileSync(join(workspace, "src/apps/api/go.mod"), "utf8")
  .split(/\r?\n/)
  .filter((line) => /^go\s/.test(line));
const go =
  directives.length === 1
    ? /^go ([1-9]\d*\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(directives[0])?.[1]
    : undefined;
if (!pnpm || !go) throw new Error("Tool versions must be exact releases.");

writeFileSync(
  join(workspace, "tool-versions.json"),
  JSON.stringify({ packageManager: `pnpm@${pnpm}` }),
  { flag: "wx" },
);
appendFileSync(output, `pnpm=${pnpm}\ngo=${go}\n`);
