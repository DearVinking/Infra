import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { api } from "./source-api.mjs";
import {
  assertPrivateSource,
  executionRepository,
  latestSourceStatus,
  requireSourceInMain,
  runURL,
  sourceInMain,
  sourceRepository,
  status,
} from "./source-ci.mjs";

const shaPattern = /^[0-9a-f]{40}$/;
const tagPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const deliveryContext = "delivery/infra";
const backendRoots = [
  "apps/api/",
  "packages/gacha-core/",
  "packages/gacha-fetch/",
];

function checkedSHA(sha) {
  if (!shaPattern.test(sha ?? "")) throw new Error("Invalid source SHA.");
  return sha;
}

function compareTags(left, right) {
  const a = left.split(".").map(BigInt);
  const b = right.split(".").map(BigInt);
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function output(values) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries(values)
      .map(([name, value]) => `${name}=${value}\n`)
      .join(""),
  );
}

function git(...args) {
  const result = spawnSync("git", args, {
    cwd: join(process.env.GITHUB_WORKSPACE, "src"),
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 10000,
  });
  if (result.error || result.status !== 0)
    throw new Error("Source Git operation failed.");
  return result.stdout.trimEnd();
}

function backendPath(path) {
  if (!backendRoots.some((root) => path.startsWith(root))) return false;
  if (path.startsWith("packages/gacha-core/analytics/")) return false;
  if (/\.(md|log|test)$/.test(path)) return false;
  return !/^apps\/api\/(?:\.env(?:\..*)?$|server$|(?:bin|tmp)\/|coverage)/.test(
    path,
  );
}

function backendRevision(sha) {
  const history = git(
    "log",
    "--format=%H",
    "--name-only",
    "-z",
    "--first-parent",
    "--diff-merges=first-parent",
    "--no-renames",
    sha,
    "--",
    ...backendRoots,
  ).split("\0");
  let commit;
  for (const entry of history) {
    const value = entry.replace(/^\n+/, "");
    if (shaPattern.test(value)) commit = value;
    else if (backendPath(value)) return checkedSHA(commit);
  }
  throw new Error("Backend source history is missing.");
}

function backendRequired(sha, retry) {
  const deployments = api(
    `repos/${sourceRepository}/deployments?environment=production&per_page=100`,
    { paginate: true },
  )
    .flat()
    .filter((value) => value.environment === "production")
    .sort((a, b) => b.id - a.id);
  const latest = deployments[0];
  if (!latest) return true;
  const previous = checkedSHA(latest.sha);
  const states = api(
    `repos/${sourceRepository}/deployments/${latest.id}/statuses?per_page=100`,
  );
  const success = states.sort((a, b) => b.id - a.id)[0]?.state === "success";
  const changed = git(
    "diff",
    "--name-only",
    "--no-renames",
    "-z",
    previous,
    sha,
  )
    .split("\0")
    .filter(Boolean)
    .some(backendPath);
  return changed || (!success && (retry || previous === sha));
}

function tagSHA(tag, expected, skipIneligible = false) {
  const ref = api(`repos/${sourceRepository}/git/ref/tags/${tag}`, {
    allowMissing: true,
  });
  if (
    !ref ||
    ref.ref !== `refs/tags/${tag}` ||
    ref.object?.type !== "commit" ||
    (expected && ref.object.sha !== expected)
  ) {
    if (skipIneligible) return null;
    throw new Error("Release reference does not match the source.");
  }
  const sha = checkedSHA(ref.object.sha);
  if (!sourceInMain(sha)) {
    if (skipIneligible) return null;
    throw new Error("Source must be in main history.");
  }
  return sha;
}

function verifyVersion(tag, sha) {
  const version = JSON.parse(git("show", `${sha}:apps/web/version.json`));
  const pkg = JSON.parse(git("show", `${sha}:apps/web/package.json`));
  if (
    ![version.major, version.minor, version.patch].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    ) ||
    `${version.major}.${version.minor}.${version.patch}` !== tag ||
    pkg.version !== tag ||
    !/^[0-9a-f]{7,40}$/.test(version.hash ?? "")
  )
    throw new Error("Source version files do not match the tag.");
}

function formalRelease(release, tag) {
  return (
    release?.tag_name === tag &&
    release.immutable === true &&
    release.draft === false &&
    release.prerelease === false
  );
}

function releasePlan(tag, sha, retry, skipIneligible = false) {
  if (!retry && latestSourceStatus(sha, "release/infra")) return null;
  if (!tagSHA(tag, sha, skipIneligible)) return null;
  const release = api(`repos/${sourceRepository}/releases/tags/${tag}`, {
    allowMissing: true,
  });
  if (formalRelease(release, tag)) return null;
  return {
    sha,
    tag,
    release: true,
    deploy: false,
    deploy_sha: "",
    existingRelease: release,
  };
}

function pendingRelease() {
  const releases = api(`repos/${sourceRepository}/releases?per_page=100`, {
    paginate: true,
  }).flat();
  const published = releases
    .filter(
      (value) =>
        !value.draft &&
        !value.prerelease &&
        tagPattern.test(value.tag_name ?? ""),
    )
    .map((value) => value.tag_name)
    .sort(compareTags)
    .at(-1);
  const tags = api(`repos/${sourceRepository}/tags?per_page=100`, {
    paginate: true,
  })
    .flat()
    .filter(
      (value) =>
        tagPattern.test(value.name ?? "") &&
        (!published || compareTags(value.name, published) > 0),
    )
    .sort((a, b) => compareTags(a.name, b.name));
  for (const tag of tags) {
    const plan = releasePlan(
      tag.name,
      checkedSHA(tag.commit?.sha),
      false,
      true,
    );
    if (plan) return plan;
  }
  return null;
}

function stages(plan) {
  return [
    ...(plan.release ? [{ sha: plan.sha, context: "release/infra" }] : []),
    ...(plan.deploy
      ? [{ sha: checkedSHA(plan.deploy_sha), context: "deploy/infra" }]
      : []),
  ];
}

function begin(plan) {
  status(plan.sha, "pending", deliveryContext);
  for (const stage of stages(plan)) status(stage.sha, "pending", stage.context);
  try {
    if (plan.release) {
      verifyVersion(plan.tag, plan.sha);
      if (plan.existingRelease)
        throw new Error("Existing release cannot be resumed automatically.");
    }
    output({
      run: true,
      sha: plan.sha,
      tag: plan.tag,
      release: plan.release,
      deploy: plan.deploy,
      deploy_sha: plan.deploy_sha,
    });
  } catch (error) {
    for (const stage of stages(plan))
      status(stage.sha, "failure", stage.context);
    status(plan.sha, "failure", deliveryContext);
    throw error;
  }
}

function prepare() {
  const sha = checkedSHA(process.env.SOURCE_SHA);
  if (git("rev-parse", "HEAD") !== sha || git("status", "--porcelain"))
    throw new Error("Source checkout is not the fixed clean commit.");
  requireSourceInMain(sha);
  const retry = process.env.RETRY_DELIVERY === "true";
  let plan;
  if (process.env.RELEASE_TAG)
    plan = retry
      ? releasePlan(process.env.RELEASE_TAG, sha, true)
      : pendingRelease();
  else {
    if (backendRequired(sha, retry)) {
      // 按真实后端变更去重，防止后续 Web/桌面提交重试已失败的后端阶段。
      const checkpoint = backendRevision(sha);
      if (retry || !latestSourceStatus(checkpoint, "deploy/infra"))
        plan = {
          sha,
          tag: "",
          release: false,
          deploy: true,
          deploy_sha: checkpoint,
        };
    }
    if (!plan && process.env.GITHUB_EVENT_NAME === "schedule")
      plan = pendingRelease();
  }
  if (plan) begin(plan);
  else output({ run: false });
}

function finish() {
  const sha = checkedSHA(process.env.SOURCE_SHA);
  if (latestSourceStatus(sha, deliveryContext)?.target_url !== runURL()) {
    console.log("Superseded delivery result ignored.");
    return;
  }
  const results = JSON.parse(process.env.CHECK_RESULTS ?? "");
  const release = process.env.RELEASE_REQUIRED;
  const deploy = process.env.DEPLOY_REQUIRED;
  const flags =
    [release, deploy].every((value) => ["true", "false"].includes(value)) &&
    (release === "true" || deploy === "true");
  const plan = {
    sha,
    release: release === "true",
    deploy: deploy === "true",
    deploy_sha: process.env.DEPLOY_SHA,
  };
  const current = stages(plan).every(
    (stage) =>
      latestSourceStatus(stage.sha, stage.context)?.target_url === runURL(),
  );
  const valid =
    flags &&
    current &&
    results.prepare?.result === "success" &&
    results.ci?.result === "success" &&
    results.release?.result === (release === "true" ? "success" : "skipped") &&
    results.deploy?.result === (deploy === "true" ? "success" : "skipped");
  for (const stage of stages(plan)) {
    if (latestSourceStatus(stage.sha, stage.context)?.target_url === runURL())
      status(stage.sha, valid ? "success" : "failure", stage.context);
  }
  status(sha, valid ? "success" : "failure", deliveryContext);
  if (!valid) throw new Error("Required delivery stages must succeed.");
}

function main(command) {
  if (
    process.env.GITHUB_REPOSITORY !== executionRepository ||
    process.env.GITHUB_REF !== "refs/heads/main" ||
    !process.env.GITHUB_OUTPUT ||
    !["schedule", "workflow_dispatch"].includes(
      process.env.GITHUB_EVENT_NAME,
    ) ||
    (process.env.RELEASE_TAG && !tagPattern.test(process.env.RELEASE_TAG))
  )
    throw new Error("Invalid delivery context.");
  assertPrivateSource();
  if (command === "snapshot")
    output({
      sha:
        process.env.RELEASE_TAG && process.env.RETRY_DELIVERY === "true"
          ? tagSHA(process.env.RELEASE_TAG)
          : checkedSHA(api(`repos/${sourceRepository}/commits/main`).sha),
    });
  else if (command === "prepare") prepare();
  else if (command === "finish") finish();
  else throw new Error("Invalid delivery command.");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main(process.argv[2]);
  } catch {
    console.error("Source delivery operation failed.");
    process.exitCode = 1;
  }
}
