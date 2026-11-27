import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const groups = ["large_import", "remaining"];
const historical = "TestFullJSONImportBeyondHistoricalLimits";
const profilePath = "apps/api/coverage-desktop.out";
const reportsPath = "coverage/go-tests";
const parameters = {
  count: 1,
  coverMode: "atomic",
  packages: "./...",
  race: true,
  timeout: "60m",
};
const flags = [
  "test",
  "-json",
  "-race",
  "-count=1",
  "-timeout=60m",
  "-covermode=atomic",
];

function environment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith("GIT_TRACE") && name !== "GIT_CURL_VERBOSE",
    ),
  );
}

function digest(text) {
  return createHash("sha256").update(text).digest("hex");
}

function writeReport(path, text) {
  mkdirSync(dirname(path), { mode: 0o700, recursive: true });
  writeFileSync(path, text, { mode: 0o600 });
}

function checkContext(root, sha) {
  assert.ok(isAbsolute(root), "Source directory must be absolute.");
  assert.match(sha, /^[0-9a-f]{40}$/, "Invalid source SHA.");
}

function toolchain(value) {
  assert.ok(value && typeof value === "object");
  assert.match(value.GOVERSION, /^go\d+\.\d+(?:\.\d+)?(?:(?:beta|rc)\d+)?$/);
  assert.match(value.GOOS, /^[a-z0-9]+$/);
  assert.match(value.GOARCH, /^[a-z0-9]+$/);
}

function inventory(value) {
  assert.ok(Array.isArray(value) && value.length > 0, "Missing packages.");
  const canonical = value.map((entry) => {
    assert.ok(typeof entry.package === "string" && entry.package.length > 0);
    assert.ok(Array.isArray(entry.names));
    for (const name of entry.names) {
      assert.match(name, /^(Test|Example|Fuzz)[^\s/]*$/);
    }
    assert.equal(new Set(entry.names).size, entry.names.length);
    return { names: [...entry.names].sort(), package: entry.package };
  });
  canonical.sort((a, b) => (a.package < b.package ? -1 : 1));
  assert.equal(
    new Set(canonical.map((entry) => entry.package)).size,
    value.length,
  );
  assert.deepEqual(value, canonical, "Test inventory must be canonical.");
  assert.equal(
    value.flatMap((entry) => entry.names).filter((name) => name === historical)
      .length,
    1,
    "The complete historical import must be registered exactly once.",
  );
  return value;
}

function selection(list, group) {
  assert.ok(groups.includes(group), "Invalid test group.");
  return list.flatMap((entry) =>
    entry.names
      .filter((name) => (group === "large_import") === (name === historical))
      .map((name) => `${entry.package}\0${name}`),
  );
}

function execution(list, selected, events) {
  assert.ok(Array.isArray(events));
  const packages = new Map(list.map((entry) => [entry.package, entry.names]));
  const expected = new Set(selected);
  const startedPackages = new Set();
  const completedPackages = new Set();
  const startedTests = new Set();
  const passedTests = new Set();
  for (const event of events) {
    assert.ok(packages.has(event.Package), "Unexpected test package.");
    assert.notEqual(event.Action, "fail", "A Go test or package failed.");
    if (event.Test !== undefined) {
      assert.equal(typeof event.Test, "string");
      const root = `${event.Package}\0${event.Test.split("/")[0]}`;
      const id = `${event.Package}\0${event.Test}`;
      assert.ok(expected.has(root), "A test outside this group executed.");
      assert.ok(startedPackages.has(event.Package));
      assert.ok(!completedPackages.has(event.Package));
      assert.notEqual(event.Action, "skip", "A required Go test was skipped.");
      if (event.Action === "run") {
        assert.ok(!startedTests.has(id), "Duplicate Go test execution.");
        startedTests.add(id);
      } else if (event.Action === "pass") {
        assert.ok(startedTests.has(id) && !passedTests.has(id));
        for (const child of startedTests) {
          if (child.startsWith(`${id}/`)) assert.ok(passedTests.has(child));
        }
        passedTests.add(id);
      } else {
        assert.ok(["pause", "cont"].includes(event.Action));
        assert.ok(startedTests.has(id) && !passedTests.has(id));
      }
    } else if (event.Action === "start") {
      assert.ok(!startedPackages.has(event.Package));
      startedPackages.add(event.Package);
    } else {
      assert.ok(["pass", "skip"].includes(event.Action));
      assert.ok(startedPackages.has(event.Package));
      assert.ok(!completedPackages.has(event.Package));
      if (event.Action === "skip")
        assert.equal(packages.get(event.Package).length, 0);
      completedPackages.add(event.Package);
    }
  }
  assert.equal(
    completedPackages.size,
    packages.size,
    "A package did not finish.",
  );
  assert.deepEqual(passedTests, startedTests, "A test did not finish.");
  const top = [...passedTests].filter((id) => !id.split("\0")[1].includes("/"));
  assert.deepEqual(new Set(top), expected, "Incomplete Go test execution.");
}

function profile(text) {
  const [mode, ...lines] = text.trimEnd().split("\n");
  assert.equal(mode, "mode: atomic", "Coverage must retain atomic mode.");
  assert.ok(lines.length > 0, "Coverage blocks are missing.");
  const blocks = new Map();
  for (const line of lines) {
    const parsed = /^(\S+:\d+\.\d+,\d+\.\d+) (\d+) (\d+)$/.exec(line);
    assert.ok(parsed, "Invalid coverage block.");
    assert.ok(!blocks.has(parsed[1]), "Duplicate coverage block.");
    blocks.set(parsed[1], { count: BigInt(parsed[3]), statements: parsed[2] });
  }
  return blocks;
}

function sameBlocks(a, b) {
  assert.equal(a.size, b.size, "Coverage block set changed.");
  for (const [key, block] of a) {
    assert.equal(
      b.get(key)?.statements,
      block.statements,
      "Coverage block changed.",
    );
  }
}

function go(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn("go", args, {
      cwd,
      env: environment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const events = [];
    let parseError;
    const lines = createInterface({ crlfDelay: Infinity, input: child.stdout });
    lines.on("line", (line) => {
      process.stdout.write(`${line}\n`);
      try {
        events.push(JSON.parse(line));
      } catch (error) {
        parseError ??= error;
      }
    });
    child.stderr.on("data", (bytes) => process.stderr.write(bytes));
    const signals = ["SIGINT", "SIGTERM"].map((signal) => {
      const forward = () => child.kill(signal);
      process.once(signal, forward);
      return [signal, forward];
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      for (const [name, forward] of signals)
        process.removeListener(name, forward);
      if (parseError) reject(parseError);
      else if (code !== 0 || signal)
        reject(new Error("Go test command failed."));
      else resolve(events);
    });
  });
}

export async function runGroup({ group, root, sha }) {
  checkContext(root, sha);
  assert.ok(groups.includes(group), "Invalid test group.");
  const module = join(root, "apps/desktop/core");
  const directory = join(root, reportsPath, group);
  const output = join(directory, "coverage.out");
  const metadata = join(directory, "metadata.out");
  const manifest = join(directory, "manifest.json");
  mkdirSync(directory, { mode: 0o700, recursive: true });
  rmSync(manifest, { force: true });
  const toolResult = spawnSync(
    "go",
    ["env", "-json", "GOVERSION", "GOOS", "GOARCH"],
    {
      cwd: module,
      encoding: "utf8",
      env: environment(),
    },
  );
  assert.equal(toolResult.status, 0, "Go tool metadata is unavailable.");
  const tool = JSON.parse(toolResult.stdout);
  toolchain(tool);
  const listing = await go(
    [...flags, "-list=^(Test|Example|Fuzz)", "./..."],
    module,
  );
  const packages = new Map();
  for (const event of listing) {
    if (event.Action === "start") packages.set(event.Package, []);
    const name = event.Output?.trim();
    if (
      event.Action === "output" &&
      /^(Test|Example|Fuzz)[^\s/]*$/.test(name ?? "")
    ) {
      assert.ok(packages.has(event.Package));
      packages.get(event.Package).push(name);
    }
  }
  const list = inventory(
    [...packages]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([pkg, names]) => ({
        names: names.sort(),
        package: pkg,
      })),
  );
  const metadataEvents = await go(
    [...flags, `-coverprofile=${metadata}`, "-run=^$", "./..."],
    module,
  );
  execution(
    list,
    [],
    metadataEvents.filter((event) => event.Action !== "output"),
  );
  const selected = selection(list, group);
  const names = [...new Set(selected.map((id) => id.split("\0")[1]))];
  assert.ok(names.length > 0, "The test group is empty.");
  const escaped = names.map((name) =>
    name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  // 只过滤顶层入口，子用例沿用 Go 的完整默认执行。
  const events = (
    await go(
      [
        ...flags,
        `-coverprofile=${output}`,
        `-run=^(${escaped.join("|")})$`,
        "./...",
      ],
      module,
    )
  )
    .filter((event) => event.Action !== "output")
    .map(({ Action, Package, Test }) => ({
      Action,
      Package,
      ...(Test === undefined ? {} : { Test }),
    }));
  execution(list, selected, events);
  const metadataText = readFileSync(metadata, "utf8");
  const profileText = readFileSync(output, "utf8");
  sameBlocks(profile(metadataText), profile(profileText));
  writeReport(
    manifest,
    JSON.stringify({
      events,
      group,
      inventory: list,
      metadataSHA: digest(metadataText),
      parameters,
      profileSHA: digest(profileText),
      sha,
      tool,
      version: 1,
    }) + "\n",
  );
}

export function mergeGroups({ directory, root, sha }) {
  checkContext(root, sha);
  const reports = groups.map((group) => {
    const input = join(directory, group);
    const value = JSON.parse(
      readFileSync(join(input, "manifest.json"), "utf8"),
    );
    assert.equal(value.version, 1);
    assert.equal(value.group, group, "Go report group mismatch.");
    assert.equal(value.sha, sha, "Go report source SHA mismatch.");
    toolchain(value.tool);
    assert.deepEqual(value.parameters, parameters);
    const list = inventory(value.inventory);
    execution(list, selection(list, value.group), value.events);
    const metadata = readFileSync(join(input, "metadata.out"), "utf8");
    const text = readFileSync(join(input, "coverage.out"), "utf8");
    assert.equal(
      digest(metadata),
      value.metadataSHA,
      "Coverage metadata digest mismatch.",
    );
    assert.equal(
      digest(text),
      value.profileSHA,
      "Coverage profile digest mismatch.",
    );
    const blocks = profile(text);
    sameBlocks(profile(metadata), blocks);
    return { blocks, manifest: value };
  });
  const first = reports[0];
  for (const report of reports.slice(1)) {
    assert.deepEqual(
      report.manifest.tool,
      first.manifest.tool,
      "Go toolchain mismatch.",
    );
    assert.deepEqual(
      report.manifest.inventory,
      first.manifest.inventory,
      "Go test inventory mismatch.",
    );
    sameBlocks(first.blocks, report.blocks);
  }
  const lines = [...first.blocks]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, block]) => {
      const count = reports.reduce(
        (sum, report) => sum + report.blocks.get(key).count,
        0n,
      );
      return `${key} ${block.statements} ${count}`;
    });
  const combined = "mode: atomic\n" + lines.join("\n") + "\n";
  writeReport(join(root, profilePath), combined);
  writeReport(
    join(root, reportsPath, "combined.json"),
    JSON.stringify({
      groups: reports.map((report) => report.manifest),
      profileSHA: digest(combined),
      sha,
      version: 1,
    }) + "\n",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  async function main() {
    assert.equal(process.argv.length, 4);
    assert.ok(process.env.GITHUB_WORKSPACE);
    const root = join(process.env.GITHUB_WORKSPACE, "src");
    const sha = process.env.SOURCE_SHA;
    if (process.argv[2] === "run")
      await runGroup({ group: process.argv[3], root, sha });
    else {
      assert.equal(process.argv[2], "merge");
      mergeGroups({ directory: process.argv[3], root, sha });
    }
  }
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
