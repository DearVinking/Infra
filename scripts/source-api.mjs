import { spawnSync } from "node:child_process";

export function api(
  endpoint,
  { body, method, query, paginate = false, allowMissing = false } = {},
) {
  const args = ["api", endpoint];
  if (body !== undefined)
    args.push("--method", method || "POST", "--input", "-");
  else if (query) args.push("--jq", query);
  if (paginate) args.push("--paginate", "--slurp");
  if (allowMissing) args.push("--include");
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    input: body === undefined ? undefined : JSON.stringify(body),
    maxBuffer: 8 * 1024 * 1024,
    timeout: 30000,
  });
  let text = result.stdout ?? "";
  if (allowMissing) {
    const code = /^HTTP\/\S+\s+(\d{3})\b/.exec(text)?.[1];
    const separator = /\r?\n\r?\n/.exec(text);
    if (!code || !separator) throw new Error("Source API response is invalid.");
    if (code === "404") return null;
    if (!/^2\d\d$/.test(code)) throw new Error("Source API request failed.");
    text = text.slice(separator.index + separator[0].length);
  }
  if (result.error || result.status !== 0)
    throw new Error("Source API request failed.");
  return JSON.parse(text);
}
