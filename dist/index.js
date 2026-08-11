// src/index.ts
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// src/published-rules.ts
var PUBLISHED_RULE_IDS = /* @__PURE__ */ new Set(["color-contrast", "image-alt", "label", "button-name", "link-name", "aria-required-attr", "html-has-lang", "document-title", "meta-viewport", "aria-valid-attr", "aria-allowed-attr", "aria-hidden-focus", "aria-valid-attr-value", "aria-required-children", "aria-roles", "duplicate-id-aria", "nested-interactive", "select-name", "scrollable-region-focusable", "autocomplete-valid"]);
function publishedRuleUrl(ruleId) {
  return PUBLISHED_RULE_IDS.has(ruleId) ? `https://wcagc.com/rules/${ruleId}` : void 0;
}

// src/core.ts
var coverage = "Automated checks cover only part of WCAG and EN 301 549. Manual review and fixes in code remain essential.";
function endpoint(base, path) {
  return base.replace(/\/$/, "") + "/api/v1" + path;
}
async function json(response) {
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`wcagc API ${response.status}: ${body.slice(0, 500)}`);
  }
  return response.json();
}
function headers(key) {
  return { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" };
}
async function runCheck(options, deps) {
  const created = await json(await deps.fetch(endpoint(options.apiBaseUrl, "/ci/checks"), { method: "POST", headers: headers(options.apiKey), body: JSON.stringify({ urls: options.urls, failOn: options.failOn, setBaseline: options.setBaseline, context: options.context ?? { provider: "github" } }) }));
  const started = deps.now();
  let delay = 1e3;
  let check;
  for (; ; ) {
    check = await json(await deps.fetch(endpoint(options.apiBaseUrl, `/ci/checks/${created.id}`), { headers: headers(options.apiKey) }));
    if (check.status === "COMPLETED" || check.status === "FAILED") break;
    if (deps.now() - started >= options.timeoutMs) throw new Error(`Timed out waiting for wcagc check ${created.id}.`);
    await deps.sleep(delay);
    delay = Math.min(5e3, Math.ceil(delay * 1.6));
  }
  const findings = await json(await deps.fetch(endpoint(options.apiBaseUrl, `/ci/checks/${created.id}/violations`), { headers: headers(options.apiKey) }));
  return { check, findings, summary: renderSummary(check), annotations: renderAnnotations(findings) };
}
function renderSummary(c) {
  const n = c.newCounts ?? { critical: 0, serious: 0, moderate: 0, minor: 0 };
  return `# wcagc CI check

**Verdict: ${c.verdict ?? "FAIL"}**${c.baselineMissing ? " \u2014 no baseline; NEW_CRITICAL fell back to ANY_CRITICAL." : ""}

| Severity | Findings | New |
|---|---:|---:|
| Critical | ${c.counts.critical} | ${n.critical} |
| Serious | ${c.counts.serious} | ${n.serious} |
| Moderate | ${c.counts.moderate} | ${n.moderate} |
| Minor | ${c.counts.minor} | ${n.minor} |

[Open the wcagc report](${c.appUrl})

> ${coverage}
`;
}
function renderAnnotations(findings) {
  return findings.map((f) => {
    const level = f.impact === "critical" || f.impact === "serious" ? "error" : f.impact === "moderate" ? "warning" : "notice";
    const fresh = f.isNew ? "New " : "";
    return `::${level} title=${escape(`${fresh}${f.impact}: ${f.ruleId}`)}::${escape(`${f.url} \u2014 ${f.failureSummary ?? f.target ?? "Automated finding"}`)}`;
  });
}
function toSarif(findings) {
  const rules = [...new Map(findings.map((f) => [f.ruleId, { id: f.ruleId, name: f.ruleId, shortDescription: { text: `axe-core rule ${f.ruleId}` }, helpUri: publishedRuleUrl(f.ruleId) ?? f.helpUrl }])).values()];
  return { $schema: "https://json.schemastore.org/sarif-2.1.0.json", version: "2.1.0", runs: [{ tool: { driver: { name: "wcagc", informationUri: "https://wcagc.com", rules } }, results: findings.map((f) => ({ ruleId: f.ruleId, level: f.impact === "critical" || f.impact === "serious" ? "error" : f.impact === "moderate" ? "warning" : "note", message: { text: `${f.failureSummary ?? "Automated accessibility finding"} Selector: ${f.target}` }, locations: [{ physicalLocation: { artifactLocation: { uri: pagePath(f.url) } } }], partialFingerprints: { wcagcFindingFingerprint: f.fingerprint } })) }] };
}
function renderPrComment(result) {
  const fresh = result.findings.filter((f) => f.isNew);
  const fixed = result.check.fixedCount ?? 0, unchanged = result.check.unchangedCount ?? result.findings.length - fresh.length;
  const rows = fresh.slice(0, 5).map((f) => {
    const guide = publishedRuleUrl(f.ruleId);
    const rule = guide ? `[\`${f.ruleId}\`](${guide})` : `\`${f.ruleId}\``;
    return `- ${rule} \u2014 ${f.url} \u2014 \`${f.target}\``;
  }).join("\n");
  return `<!-- wcagc-check -->
## wcagc accessibility check

**Verdict: ${result.check.verdict ?? "FAIL"}**

${fresh.length} new findings since baseline \xB7 ${fixed} fixed \xB7 ${unchanged} unchanged

${rows || "No new findings to list."}

[Open the wcagc report](${result.check.appUrl})

> ${coverage}
`;
}
function pagePath(value) {
  try {
    const url = new URL(value);
    return `${url.pathname || "/"}${url.search}`;
  } catch {
    return value;
  }
}
function escape(value) {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A").replace(/:/g, "%3A").replace(/,/g, "%2C");
}

// src/github-comment.ts
import { readFile } from "node:fs/promises";
var commentMarker = "<!-- wcagc-check -->";
async function githubCommentContext(env) {
  if (!env.GITHUB_REPOSITORY || !env.GITHUB_EVENT_PATH) return null;
  let event;
  try {
    event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8"));
  } catch {
    return null;
  }
  const pullRequest = event.pull_request?.number ?? event.number;
  if (!pullRequest) return null;
  const head = event.pull_request?.head?.repo?.full_name;
  return { repository: env.GITHUB_REPOSITORY, pullRequest, fork: Boolean(head && head !== env.GITHUB_REPOSITORY) };
}
async function upsertPrComment(context, token, body, fetcher = fetch) {
  const base = `https://api.github.com/repos/${context.repository}`;
  const headers2 = { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "content-type": "application/json", "x-github-api-version": "2022-11-28" };
  const list = await fetcher(`${base}/issues/${context.pullRequest}/comments?per_page=100`, { headers: headers2 });
  if (!list.ok) throw new Error(`GitHub comment lookup returned ${list.status}.`);
  const existing = (await list.json()).find((comment) => comment.body?.includes(commentMarker));
  const response = existing ? await fetcher(`${base}/issues/comments/${existing.id}`, { method: "PATCH", headers: headers2, body: JSON.stringify({ body }) }) : await fetcher(`${base}/issues/${context.pullRequest}/comments`, { method: "POST", headers: headers2, body: JSON.stringify({ body }) });
  if (!response.ok) throw new Error(`GitHub comment write returned ${response.status}.`);
  return existing ? "updated" : "created";
}

// src/index.ts
var input = (name, fallback = "") => process.env[`INPUT_${name.toUpperCase()}`] ?? fallback;
var bool = (name, fallback) => ["1", "true", "yes"].includes(input(name, String(fallback)).toLowerCase());
var failOn = (value) => ({ "new-critical": "NEW_CRITICAL", "any-critical": "ANY_CRITICAL", "serious-or-worse": "SERIOUS_OR_WORSE", none: "NONE" })[value] ?? (() => {
  throw new Error(`Unsupported fail-on value: ${value}`);
})();
async function output(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (file) await appendFile(file, `${name}=${value}
`);
  else console.log(`${name}=${value}`);
}
async function summary(value) {
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, value.endsWith("\n") ? value : `${value}
`);
}
try {
  const apiKey = input("API-KEY");
  if (!apiKey) throw new Error("api-key is required.");
  console.log(`::add-mask::${apiKey}`);
  const urls = input("URLS").split(/\r?\n/).map((v) => v.trim()).filter(Boolean);
  if (!urls.length) throw new Error("urls must contain at least one URL.");
  const result = await runCheck({ apiKey, urls, failOn: failOn(input("FAIL-ON", "new-critical")), setBaseline: bool("SET-BASELINE", false), timeoutMs: Number(input("WAIT-TIMEOUT-SECONDS", "600")) * 1e3, apiBaseUrl: input("API-BASE-URL", "https://api.wcagc.com"), context: { provider: "github", repo: process.env.GITHUB_REPOSITORY, ref: process.env.GITHUB_REF, sha: process.env.GITHUB_SHA, runUrl: process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : void 0 } }, { fetch, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: Date.now });
  if (bool("ANNOTATIONS", true)) for (const line of result.annotations) console.log(line);
  await summary(result.summary);
  const sarifFile = input("SARIF-FILE").trim();
  if (sarifFile) {
    await mkdir(dirname(sarifFile), { recursive: true });
    await writeFile(sarifFile, `${JSON.stringify(toSarif(result.findings), null, 2)}
`);
  }
  if (bool("COMMENT", false)) {
    const token = input("GITHUB-TOKEN").trim();
    const context = await githubCommentContext(process.env);
    if (!token) await summary("PR comment skipped: no GitHub token was provided.");
    else if (!context) await summary("PR comment skipped: this run is not attached to a pull request.");
    else if (context.fork) await summary("PR comment skipped: fork pull requests use a read-only token.");
    else try {
      const state = await upsertPrComment(context, token, renderPrComment(result));
      await summary(`PR comment ${state}.`);
    } catch (error) {
      await summary(`PR comment skipped: ${error instanceof Error ? error.message : "GitHub did not allow the comment."}`);
    }
  }
  const c = result.check.counts, n = result.check.newCounts;
  await output("verdict", result.check.verdict ?? "FAIL");
  await output("check-id", result.check.id);
  await output("critical-count", c.critical);
  await output("serious-count", c.serious);
  await output("moderate-count", c.moderate);
  await output("minor-count", c.minor);
  await output("new-critical-count", n?.critical ?? 0);
  await output("report-url", result.check.appUrl);
  if (result.check.verdict !== "PASS") throw new Error(result.check.failureReason ?? `wcagc check ${result.check.id} returned FAIL.`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`::error title=wcagc CI check::${message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")}`);
  process.exitCode = 1;
}
