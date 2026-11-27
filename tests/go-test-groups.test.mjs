import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { mergeGroups } from "../scripts/go-test-groups.mjs";

test("two runs on one checkout retain separate, complete coverage evidence", (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "ci-go-groups-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const root = join(workspace, "src");
  const module = join(root, "apps/desktop/core");
  const sha = "a".repeat(40);
  mkdirSync(module, { recursive: true });
  writeFileSync(
    join(module, "go.mod"),
    "module example.com/fixture\n\ngo 1.22\n",
  );
  writeFileSync(
    join(module, "fixture.go"),
    "package fixture\nfunc value() int { return 42 }\n",
  );
  writeFileSync(
    join(module, "fixture_test.go"),
    `package fixture
import "testing"
func TestFullJSONImportBeyondHistoricalLimits(t *testing.T) { if value() != 42 { t.Fatal("wrong value") } }
func TestOther(t *testing.T) { if value() != 42 { t.Fatal("wrong value") } }
`,
  );
  const directory = join(root, "coverage/go-tests");
  const merge = () => mergeGroups({ directory, root, sha });
  const run = (group) =>
    execFileSync(
      process.execPath,
      [
        fileURLToPath(
          new URL("../scripts/go-test-groups.mjs", import.meta.url),
        ),
        "run",
        group,
      ],
      { env: { ...process.env, GITHUB_WORKSPACE: workspace, SOURCE_SHA: sha } },
    );
  run("large_import");
  assert.throws(merge);
  run("remaining");
  merge();
  const combined = JSON.parse(
    readFileSync(join(directory, "combined.json"), "utf8"),
  );
  assert.deepEqual(
    combined.groups.map((g) => g.group),
    ["large_import", "remaining"],
  );
  assert.match(
    readFileSync(join(root, "apps/api/coverage-desktop.out"), "utf8"),
    / 1 2\n/,
  );
  assert.throws(
    () => mergeGroups({ directory, root, sha: "b".repeat(40) }),
    /SHA/,
  );
  copyFileSync(
    join(directory, "large_import/manifest.json"),
    join(directory, "remaining/manifest.json"),
  );
  assert.throws(merge, /group mismatch/);
});
