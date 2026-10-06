import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const sshScript = readFileSync(
  new URL("./astrionyx.sh", import.meta.url),
  "utf8",
);
// Exercise deployment after registry login and changing to the deployment directory.
const deployment = sshScript.slice(sshScript.indexOf("docker compose pull"));

function runDeployment(t, scenario) {
  const dir = mkdtempSync(path.join(tmpdir(), "astrionyx-deploy-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, "commands.jsonl");
  writeFileSync(
    path.join(dir, "docker"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.DEPLOY_TEST_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "compose" && args[1] === "up" && args.includes("--wait") && process.env.DEPLOY_TEST_SCENARIO === "crashing") process.exit(1);
if (args[0] === "inspect") console.log(process.env.DEPLOY_TEST_SCENARIO === "wrong-image" ? "old-image" : process.env.API_IMAGE);
if (args[0] === "exec" && process.env.DEPLOY_TEST_SCENARIO === "database-unavailable") process.exit(1);
`,
    { mode: 0o755 },
  );
  const result = spawnSync("bash", ["-euo", "pipefail", "-c", deployment], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      API_IMAGE: "test-image:sha-current",
      DEPLOY_TEST_LOG: log,
      DEPLOY_TEST_SCENARIO: scenario,
    },
  });
  assert.ifError(result.error);
  const commands = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  return { ...result, commands };
}

for (const scenario of ["crashing", "database-unavailable", "wrong-image"]) {
  test(`deployment fails without pruning images when ${scenario}`, (t) => {
    const result = runDeployment(t, scenario);
    assert.notEqual(result.status, 0, result.stdout);
    assert.ok(
      !result.commands.some(
        (args) => args[0] === "image" && args[1] === "prune",
      ),
    );
  });
}

test("deployment succeeds only after waiting and probing database readiness", (t) => {
  const result = runDeployment(t, "healthy");
  assert.equal(result.status, 0, result.stderr);
  const probe = result.commands.findIndex(
    (args) =>
      args[0] === "exec" && args.includes("http://127.0.0.1:8523/api/ready"),
  );
  const prune = result.commands.findIndex(
    (args) => args[0] === "image" && args[1] === "prune",
  );
  assert.ok(
    result.commands.some(
      (args) =>
        args[0] === "compose" && args[1] === "up" && args.includes("--wait"),
    ),
  );
  assert.ok(probe >= 0 && prune > probe, "readiness must pass before pruning");
});
