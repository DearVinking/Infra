import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { assertCIResults, executionRepository } from "./source-ci.mjs";

const checkJobs = [
  "web_tests",
  "quality",
  "go_tests",
  "desktop_macos",
  "desktop_macos_go",
  "desktop_macos_sanitizer",
  "desktop_macos_main_thread",
  "desktop_macos_integration",
];

export function assertSuccessfulRun(needs) {
  const plan = needs?.prepare?.outputs;
  if (
    needs?.prepare?.result !== "success" ||
    !["false", "true"].includes(plan?.run)
  ) {
    throw new Error("The current run must be successful.");
  }
  if (plan.run === "false") {
    if (
      [...checkJobs, "ci", "release", "deploy", "finish"].some(
        (name) => needs[name]?.result !== "skipped",
      )
    ) {
      throw new Error("The current no-op run must be complete.");
    }
    return;
  }
  assertCIResults(needs);
  if (needs.ci?.result !== "success" || needs.finish?.result !== "success") {
    throw new Error("The current run must be complete.");
  }
  for (const stage of ["release", "deploy"]) {
    if (
      !["false", "true"].includes(plan[stage]) ||
      needs[stage]?.result !== (plan[stage] === "true" ? "success" : "skipped")
    ) {
      throw new Error("The planned delivery stages must be successful.");
    }
  }
}

function request(endpoint, method = "GET") {
  const result = spawnSync(
    "gh",
    ["api", "--hostname", "github.com", "--method", method, endpoint],
    {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: 30000,
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error("The current run artifact request failed.");
  }
  return method === "GET" ? JSON.parse(result.stdout) : undefined;
}

function listArtifacts(runId) {
  const ids = new Set();
  let total;
  for (let page = 1; ; page++) {
    const result = request(
      `repos/${executionRepository}/actions/runs/${runId}/artifacts?per_page=100&page=${page}`,
    );
    if (
      !Number.isSafeInteger(result?.total_count) ||
      result.total_count < 0 ||
      !Array.isArray(result.artifacts) ||
      result.artifacts.length > 100 ||
      (total !== undefined && result.total_count !== total)
    ) {
      throw new Error("The current run artifact listing is invalid.");
    }
    total = result.total_count;
    for (const artifact of result.artifacts) {
      if (
        !Number.isSafeInteger(artifact?.id) ||
        artifact.id < 1 ||
        artifact.workflow_run?.id !== Number(runId) ||
        ids.has(artifact.id)
      ) {
        throw new Error("The artifact does not belong to the current run.");
      }
      ids.add(artifact.id);
    }
    if (ids.size === total) return ids;
    if (ids.size > total || result.artifacts.length === 0) {
      throw new Error("The current run artifact listing is incomplete.");
    }
  }
}

function main() {
  const runId = process.env.GITHUB_RUN_ID;
  if (
    process.argv.length !== 2 ||
    process.env.GITHUB_REPOSITORY !== executionRepository ||
    !/^[1-9]\d*$/.test(runId ?? "") ||
    !Number.isSafeInteger(Number(runId)) ||
    !process.env.GH_TOKEN
  ) {
    throw new Error("Invalid current run cleanup context.");
  }
  assertSuccessfulRun(JSON.parse(process.env.CHECK_RESULTS ?? ""));
  // 全部分页完成后才删除，避免删除导致后续分页跳过产物。
  const ids = listArtifacts(runId);
  for (const id of ids) {
    request(`repos/${executionRepository}/actions/artifacts/${id}`, "DELETE");
  }
  if (listArtifacts(runId).size !== 0) {
    throw new Error("Artifacts remain in the current run.");
  }
  console.log(`当前运行的 Actions 产物已全部清理（${ids.size} 个）。`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch {
    console.error("::error::当前运行的 Actions 产物清理失败。");
    process.exitCode = 1;
  }
}
