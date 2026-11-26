import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { api } from "./source-api.mjs";

export const sourceRepository = "DearVinking/Astrionyx";
export const executionRepository = "DearVinking/Infra";
const sonarProject = "DearVinking_Astrionyx";
const shaPattern = /^[0-9a-f]{40}$/;
const runURLPattern =
  /^https:\/\/github\.com\/DearVinking\/Infra\/actions\/runs\/([1-9]\d*)\/attempts\/([1-9]\d*)$/;

export function assertPrivateSonarProject(value) {
  if (
    value?.component?.key !== sonarProject ||
    value.component.visibility !== "private"
  ) {
    throw new Error("Sonar project must be private.");
  }
}

export function assertCIResults(value) {
  for (const name of [
    "prepare",
    "web_tests",
    "quality",
    "go_tests",
    "desktop_macos",
    "desktop_macos_go",
    "desktop_macos_sanitizer",
    "desktop_macos_main_thread",
    "desktop_macos_integration",
  ]) {
    if (value?.[name]?.result !== "success") {
      throw new Error("Required CI checks must succeed.");
    }
  }
}

export function runURL() {
  if (
    !/^[1-9]\d*$/.test(process.env.GITHUB_RUN_ID ?? "") ||
    !/^[1-9]\d*$/.test(process.env.GITHUB_RUN_ATTEMPT ?? "")
  ) {
    throw new Error("Invalid CI run.");
  }
  return `https://github.com/${executionRepository}/actions/runs/${process.env.GITHUB_RUN_ID}/attempts/${process.env.GITHUB_RUN_ATTEMPT}`;
}

export function status(sha, state, context = "ci/infra") {
  if (!shaPattern.test(sha)) throw new Error("Invalid source SHA.");
  api(`repos/${sourceRepository}/statuses/${sha}`, {
    body: {
      context,
      state,
      description: `Infra ${context === "ci/infra" ? "CI" : "delivery"}: ${state}`,
      target_url: runURL(),
    },
  });
}

export function latestSourceStatus(sha, context = "ci/infra") {
  if (!shaPattern.test(sha)) throw new Error("Invalid source SHA.");
  const statuses = api(
    `repos/${sourceRepository}/commits/${sha}/statuses?per_page=100`,
    { paginate: true },
  )
    .flat()
    .filter((value) => value.context === context)
    .sort((a, b) => b.id - a.id);
  if (!statuses.length) return undefined;
  const pending = statuses
    .filter((value) => value.state === "pending")
    .sort((a, b) => {
      const left = runURLPattern.exec(a.target_url ?? "");
      const right = runURLPattern.exec(b.target_url ?? "");
      if (!left || !right) throw new Error("Invalid source CI generation.");
      const order =
        BigInt(right[1]) - BigInt(left[1]) ||
        BigInt(right[2]) - BigInt(left[2]);
      return order > 0n ? 1 : order < 0n ? -1 : b.id - a.id;
    })[0];
  if (!pending || !runURLPattern.test(pending.target_url ?? "")) {
    throw new Error("Source CI generation is missing.");
  }
  return statuses.find(
    (value) =>
      value.id >= pending.id && value.target_url === pending.target_url,
  );
}

export function assertPrivateSource() {
  if (
    api(`repos/${sourceRepository}`, { query: "{private: .private}" })
      .private !== true
  ) {
    throw new Error("Source repository must be private.");
  }
}

export function sourceInMain(sha) {
  if (!shaPattern.test(sha)) throw new Error("Invalid source SHA.");
  const comparison = api(`repos/${sourceRepository}/compare/${sha}...main`, {
    query: "{status: .status}",
  });
  if (
    !["ahead", "identical", "behind", "diverged"].includes(comparison.status)
  ) {
    throw new Error("Source comparison response is invalid.");
  }
  return ["ahead", "identical"].includes(comparison.status);
}

export function requireSourceInMain(sha) {
  if (!sourceInMain(sha)) {
    throw new Error("Source must be in main history.");
  }
}

export function requirePassedSource(sha) {
  requireSourceInMain(sha);
  const result = latestSourceStatus(sha);
  if (result?.state !== "success" || result.target_url !== runURL()) {
    throw new Error("Current source CI must be the latest successful run.");
  }
}

function requirePlannedDelivery(sha, context, checkpoint) {
  for (const [revision, stage] of [
    [sha, "delivery/infra"],
    [checkpoint, context],
  ]) {
    const registration = latestSourceStatus(revision, stage);
    if (
      registration?.state !== "pending" ||
      registration.target_url !== runURL()
    ) {
      throw new Error("A complete delivery attempt must be prepared.");
    }
  }
}

async function main(command) {
  if (process.env.GITHUB_REPOSITORY !== executionRepository) {
    throw new Error("Invalid execution repository.");
  }
  if (command === "start") {
    const ref = process.env.SOURCE_REF || "main";
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(ref) ||
      ref.includes("..") ||
      ref.includes("//") ||
      /[/.]$|\.lock$/.test(ref) ||
      !process.env.GITHUB_OUTPUT
    ) {
      throw new Error("Invalid source ref.");
    }
    assertPrivateSource();
    const { sha } = api(
      `repos/${sourceRepository}/commits/${encodeURIComponent(ref)}`,
      { query: "{sha: .sha}" },
    );
    if (!shaPattern.test(sha)) throw new Error("Invalid source SHA.");
    status(sha, "pending");
    appendFileSync(process.env.GITHUB_OUTPUT, `sha=${sha}\n`);
  } else if (command === "release-source") {
    const tag = process.env.RELEASE_TAG;
    if (
      process.env.GITHUB_REF !== "refs/heads/main" ||
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag ?? "") ||
      !process.env.GITHUB_OUTPUT
    ) {
      throw new Error("Invalid release tag.");
    }
    assertPrivateSource();
    const reference = api(`repos/${sourceRepository}/git/ref/tags/${tag}`);
    const sha = reference.object?.sha;
    if (
      reference.ref !== `refs/tags/${tag}` ||
      reference.object?.type !== "commit" ||
      !shaPattern.test(sha) ||
      sha !== process.env.SOURCE_SHA
    ) {
      throw new Error("Invalid release reference.");
    }
    requirePassedSource(sha);
    requirePlannedDelivery(sha, "release/infra", sha);
    appendFileSync(process.env.GITHUB_OUTPUT, `sha=${sha}\n`);
  } else if (command === "deploy-source") {
    if (
      process.env.GITHUB_REF !== "refs/heads/main" ||
      !process.env.GITHUB_OUTPUT
    ) {
      throw new Error("Invalid deployment context.");
    }
    assertPrivateSource();
    const sha = process.env.SOURCE_SHA;
    requirePassedSource(sha);
    requirePlannedDelivery(sha, "deploy/infra", process.env.DEPLOY_SHA);
    appendFileSync(process.env.GITHUB_OUTPUT, `sha=${sha}\n`);
  } else if (command === "finish") {
    if (!["success", "failure"].includes(process.env.CI_RESULT)) {
      throw new Error("Invalid CI result.");
    }
    if (latestSourceStatus(process.env.SOURCE_SHA)?.target_url !== runURL()) {
      console.log("Superseded CI result ignored.");
      return;
    }
    status(process.env.SOURCE_SHA, process.env.CI_RESULT);
  } else if (command === "gate") {
    status(process.env.SOURCE_SHA, "pending");
    assertCIResults(JSON.parse(process.env.CHECK_RESULTS ?? ""));
  } else if (command === "sonar-private") {
    if (!process.env.SONAR_TOKEN) throw new Error("Missing Sonar token.");
    const response = await fetch(
      `https://sonarcloud.io/api/components/show?component=${sonarProject}`,
      {
        headers: { Authorization: `Bearer ${process.env.SONAR_TOKEN}` },
        redirect: "error",
        signal: AbortSignal.timeout(30000),
      },
    );
    if (!response.ok) throw new Error("Sonar privacy check failed.");
    assertPrivateSonarProject(await response.json());
  } else {
    throw new Error("Invalid command.");
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv[2]).catch(() => {
    console.error("Source CI operation failed.");
    process.exitCode = 1;
  });
}
