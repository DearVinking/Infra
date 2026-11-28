import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const command = fileURLToPath(
  new URL("../scripts/source-delivery.mjs", import.meta.url),
);
const repository = "DearVinking/Astrionyx";
const runURL =
  "https://github.com/DearVinking/Infra/actions/runs/100/attempts/1";
const tag = "1.0.1";

function fixture(
  t,
  {
    changed = true,
    tagged = true,
    later,
    versionCommit = false,
    retry = true,
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "infra-delivery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const src = join(root, "src");
  mkdirSync(join(src, "apps/web"), { recursive: true });
  mkdirSync(join(src, "apps/api"), { recursive: true });
  const git = (...args) =>
    execFileSync("git", args, { cwd: src, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "Fixture");
  git("config", "commit.gpgSign", "false");
  const commit = (path, value) => {
    writeFileSync(join(src, path), value);
    git("add", ".");
    git("commit", "-qm", "fixture");
    return git("rev-parse", "HEAD");
  };
  writeFileSync(
    join(src, "apps/web/version.json"),
    '{"major":1,"minor":0,"patch":1,"hash":"abcdef0"}',
  );
  writeFileSync(join(src, "apps/web/package.json"), '{"version":"1.0.1"}');
  const prior = commit("apps/api/example.go", "old");
  const revision = commit("apps/api/example.go", "new");
  const target = versionCommit ? commit("apps/web/version.txt", tag) : revision;
  const main = later ? commit(later, "later") : target;
  const responses = {
    "": { private: true },
    "/commits/main": { sha: main },
    [`/git/ref/tags/${tag}`]: {
      ref: `refs/tags/${tag}`,
      object: { sha: target, type: "commit" },
    },
    "/deployments?environment=production&per_page=100": [
      { id: 1, sha: changed ? prior : main, environment: "production" },
    ],
    "/deployments/1/statuses?per_page=100": [{ id: 5, state: "success" }],
    "/releases?per_page=100": [],
    "/tags?per_page=100": [{ name: tag, commit: { sha: target } }],
  };
  for (const sha of [prior, revision, target, main]) {
    responses[`/compare/${sha}...main`] = {
      status: sha === main ? "identical" : "ahead",
    };
    responses[`/commits/${sha}/statuses?per_page=100`] = [];
  }
  const gh = join(root, "gh");
  writeFileSync(
    gh,
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const endpoint = args[1].replace("repos/${repository}", "");
if (args.includes("--input")) {
  const body = JSON.parse(fs.readFileSync(0, "utf8"));
  fs.appendFileSync(process.env.FIXTURE_WRITES, JSON.stringify({ endpoint, ...body }) + "\\n");
  console.log("{}");
} else {
  const value = JSON.parse(fs.readFileSync(process.env.FIXTURE_RESPONSES))[endpoint];
  if (args.includes("--include")) console.log(value === undefined ? "HTTP/2 404\\n" : "HTTP/2 200\\n");
  else if (value === undefined) process.exit(1);
  console.log(JSON.stringify(args.includes("--slurp") ? [value] : value ?? {}));
}
`,
    { mode: 0o700 },
  );
  const output = join(root, "out");
  const writes = join(root, "writes");
  const responsePath = join(root, "responses");
  const env = {
    ...process.env,
    PATH: `${root}${delimiter}${process.env.PATH}`,
    FIXTURE_RESPONSES: responsePath,
    FIXTURE_WRITES: writes,
    GITHUB_REPOSITORY: "DearVinking/Infra",
    GITHUB_WORKSPACE: root,
    GITHUB_OUTPUT: output,
    GITHUB_REF: "refs/heads/main",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_RUN_ID: "100",
    GITHUB_RUN_ATTEMPT: "1",
    RELEASE_TAG: tagged ? tag : "",
    RETRY_DELIVERY: String(retry),
    SOURCE_SHA: main,
  };
  const run = (step, overrides = {}) => {
    writeFileSync(responsePath, JSON.stringify(responses));
    writeFileSync(output, "");
    writeFileSync(writes, "");
    const result = spawnSync(process.execPath, [command, step], {
      env: { ...env, ...overrides },
      encoding: "utf8",
    });
    assert.ifError(result.error);
    return {
      code: result.status,
      stderr: result.stderr,
      output: Object.fromEntries(
        readFileSync(output, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => line.split("=")),
      ),
      writes: readFileSync(writes, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    };
  };
  return { revision, target, main, responses, run };
}

for (const changed of [false, true]) {
  for (const tagged of [false, true]) {
    for (const retry of [false, true]) {
      test(`deployment=${changed}, release=${tagged}, manual retry=${retry}`, (t) => {
        const rig = fixture(t, { changed, tagged, retry });
        const result = rig.run("prepare");
        assert.equal(result.code, 0, result.stderr);
        assert.deepEqual(
          result.output,
          changed || tagged
            ? {
                run: "true",
                sha: rig.target,
                tag: tagged ? tag : "",
                release: String(tagged),
                deploy: String(changed),
                deploy_sha: changed ? rig.target : "",
              }
            : { run: "false" },
        );
      });
    }
  }
}

test("a tag may share the main backend after a desktop-only change", (t) => {
  const rig = fixture(t, { later: "apps/web/desktop.txt" });
  assert.equal(rig.run("snapshot").output.sha, rig.main);
  const result = rig.run("prepare");
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.output, {
    run: "true",
    sha: rig.target,
    tag,
    release: "true",
    deploy: "true",
    deploy_sha: rig.target,
  });
});

test("one CI SHA with distinct backend and release status registrations", (t) => {
  const rig = fixture(t, { versionCommit: true });
  const result = rig.run("prepare");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.output.sha, rig.target);
  assert.equal(result.output.deploy_sha, rig.revision);
  assert.deepEqual(
    result.writes.map(({ endpoint, context }) => [endpoint, context]),
    [
      [`/statuses/${rig.target}`, "delivery/infra"],
      [`/statuses/${rig.target}`, "release/infra"],
      [`/statuses/${rig.revision}`, "deploy/infra"],
    ],
  );
});

for (const retry of [false, true]) {
  test(`an older unpublished tag cannot become latest, retry=${retry}`, (t) => {
    const rig = fixture(t, { retry });
    rig.responses["/releases?per_page=100"] = [
      { tag_name: "1.2.0", immutable: true, draft: false, prerelease: false },
    ];
    const result = rig.run("prepare");
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.output.release, "false");
    assert.equal(result.output.deploy, "true");
  });
}

test("an existing draft stops before deploying or publishing", (t) => {
  const rig = fixture(t);
  rig.responses["/releases?per_page=100"] = [{ tag_name: tag, draft: true }];
  const result = rig.run("prepare");
  assert.notEqual(result.code, 0);
  assert.deepEqual(result.writes, []);
});

test("an invalid version tag cannot reserve the backend or the release", (t) => {
  const rig = fixture(t);
  const wrong = "1.0.2";
  rig.responses[`/git/ref/tags/${wrong}`] = {
    ref: `refs/tags/${wrong}`,
    object: { sha: rig.target, type: "commit" },
  };
  const result = rig.run("prepare", { RELEASE_TAG: wrong });
  assert.notEqual(result.code, 0);
  assert.deepEqual(result.writes, []);
});

test("an old tag cannot roll back or publish ahead of a required newer backend", (t) => {
  const rig = fixture(t, { later: "apps/api/example.go" });
  assert.notEqual(rig.run("prepare").code, 0);
  rig.responses["/deployments?environment=production&per_page=100"][0].sha =
    rig.main;
  const result = rig.run("prepare");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.output.sha, rig.target);
  assert.equal(result.output.deploy, "false");
});

test("a published tag does not suppress a pending production deployment", (t) => {
  const rig = fixture(t);
  const published = {
    tag_name: tag,
    immutable: true,
    draft: false,
    prerelease: false,
  };
  rig.responses["/releases?per_page=100"] = [published];
  rig.responses[`/releases/tags/${tag}`] = published;
  const result = rig.run("prepare");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.output.deploy, "true");
  assert.equal(result.output.release, "false");
});

test("an automatic event cannot silently skip a failed required deployment", (t) => {
  const rig = fixture(t, { retry: false });
  rig.responses[`/commits/${rig.target}/statuses?per_page=100`] = [
    { id: 2, context: "deploy/infra", state: "failure", target_url: runURL },
    { id: 1, context: "deploy/infra", state: "pending", target_url: runURL },
  ];
  assert.notEqual(rig.run("prepare").code, 0);
  assert.equal(
    rig.run("prepare", { RETRY_DELIVERY: "true" }).output.deploy,
    "true",
  );
});

test("successful deployment stays successful when publication fails", (t) => {
  const rig = fixture(t);
  rig.responses[`/commits/${rig.main}/statuses?per_page=100`] = [
    "release/infra",
    "deploy/infra",
    "delivery/infra",
  ].map((context, id) => ({
    context,
    id: id + 1,
    target_url: runURL,
    state: "pending",
  }));
  const result = rig.run("finish", {
    DEPLOY_REQUIRED: "true",
    RELEASE_REQUIRED: "true",
    DEPLOY_SHA: rig.main,
    CHECK_RESULTS: JSON.stringify({
      prepare: { result: "success" },
      ci: { result: "success" },
      deploy: { result: "success" },
      release: { result: "failure" },
    }),
  });
  assert.notEqual(result.code, 0);
  assert.deepEqual(
    Object.fromEntries(
      result.writes.map((entry) => [entry.context, entry.state]),
    ),
    {
      "release/infra": "failure",
      "deploy/infra": "success",
      "delivery/infra": "failure",
    },
  );
});

test("the release job waits for readiness, not just for shared CI", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/astrionyx-release.yml", import.meta.url),
    "utf8",
  );
  const job = workflow.match(/^  release:\n([\s\S]*?)(?=^  \w+:)/m)[1];
  assert.match(job, /needs: \[prepare, ci, deploy\]/);
  const condition = job
    .match(/^    if: >-\n([\s\S]*?)(?=^    \S)/m)[1]
    .trim()
    .replace(/^\$\{\{|\}\}$/g, "");
  for (const required of [false, true]) {
    for (const result of ["success", "skipped", "failure", "cancelled"]) {
      for (const ci of ["success", "failure"]) {
        const needs = {
          prepare: {
            result: "success",
            outputs: { release: "true", deploy: String(required) },
          },
          ci: { result: ci },
          deploy: { result },
        };
        assert.equal(
          runInNewContext(condition, { needs, cancelled: () => false }),
          ci === "success" && result === (required ? "success" : "skipped"),
        );
        assert.equal(
          runInNewContext(condition, { needs, cancelled: () => true }),
          false,
        );
      }
    }
  }
});

test("publication rechecks the tag and CI binding after signing", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/astrionyx-release.yml", import.meta.url),
    "utf8",
  );
  const publish = workflow
    .split("验证 draft 原字节并发布不可变 Release")[1]
    .split("\n      - name:")[0];
  assert.match(publish, /SOURCE_SHA: \$\{\{ steps\.source\.outputs\.sha \}\}/);
  assert.match(
    publish,
    /node "\$GITHUB_WORKSPACE\/scripts\/source-ci\.mjs" release-source[\s\S]*desktop-release\.mjs publish/,
  );
});
