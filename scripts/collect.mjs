#!/usr/bin/env node
// ── Overseer dashboard collector ──────────────────────────────────────────
// Runs in GitHub Actions (NOT the browser). Gathers every repo's GitHub-side
// truth server-side using the Action's token (5000/hr, no client secret), then
// writes a single static data/status.json that the dashboard loads with ONE
// request. This is the whole point of the pivot: the browser never touches the
// GitHub API, so there's no 60/hr unauthenticated rate-limit wall.
//
// Auth: uses DASHBOARD_PAT if present (lets it read private repos), else the
// auto-provisioned GITHUB_TOKEN (public repos + this repo's own privates).
// Never throws on a single repo's failure — degrades that card gracefully.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const cfg = JSON.parse(await readFile(join(ROOT, "repos.json"), "utf8"));

const OWNER = cfg.owner;
const TOKEN = process.env.DASHBOARD_PAT || process.env.GITHUB_TOKEN || "";
const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";
const MAX_COMPARES = cfg.maxBranchCompares ?? 12;

const headers = {
  Accept: "application/vnd.github+json",
  "User-Agent": "overseer-dashboard-collector",
  "X-GitHub-Api-Version": "2022-11-28",
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
};

// GET a GitHub API path. Returns {ok, status, data}. Never throws.
async function api(path) {
  try {
    const res = await fetch(`${API}/repos/${OWNER}/${path}`, { headers });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, status: res.status, data: await res.json() };
  } catch (e) {
    return { ok: false, status: 0, error: e.message };
  }
}

async function rawText(repo, branch, path) {
  try {
    const res = await fetch(`${RAW}/${OWNER}/${repo}/${branch}/${path}`);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

// ── Per-repo collection ──────────────────────────────────────────────────
async function collectRepo(r) {
  const base = { repo: r.repo, note: r.note ?? "", deploys: !!r.deploys, support: !!r.support, private: !!r.private };

  const meta = await api(r.repo);
  if (!meta.ok) {
    const err = meta.status === 404 ? (r.private ? "private — not accessible" : "not found")
      : meta.status === 403 ? "forbidden"
      : meta.status ? `HTTP ${meta.status}` : (meta.error || "load failed");
    return { ...base, ok: false, err };
  }
  const def = meta.data.default_branch;
  const pushedAt = meta.data.pushed_at;

  const [commits, branches, pulls, runs] = await Promise.all([
    api(`${r.repo}/commits?per_page=1`),
    api(`${r.repo}/branches?per_page=100`),
    api(`${r.repo}/pulls?state=open&per_page=10`),
    api(`${r.repo}/actions/runs?per_page=1`),
  ]);

  const commitList = commits.ok && Array.isArray(commits.data) ? commits.data : [];
  const last = commitList[0];

  const branchList = branches.ok && Array.isArray(branches.data) ? branches.data : [];
  const others = branchList.filter((b) => b.name !== def).slice(0, MAX_COMPARES);
  const compared = await Promise.all(
    others.map(async (b) => {
      const c = await api(`${r.repo}/compare/${encodeURIComponent(def)}...${encodeURIComponent(b.name)}`);
      if (!c.ok || !c.data) return { name: b.name, ahead: null, behind: null };
      return { name: b.name, ahead: c.data.ahead_by, behind: c.data.behind_by };
    })
  );
  compared.sort((a, b) => (b.ahead || 0) - (a.ahead || 0));

  const prs = pulls.ok && Array.isArray(pulls.data)
    ? pulls.data.map((p) => ({ number: p.number, title: p.title, html_url: p.html_url }))
    : [];

  const run = runs.ok && runs.data && runs.data.workflow_runs && runs.data.workflow_runs[0]
    ? runs.data.workflow_runs[0]
    : null;
  const ci = run ? { status: run.status, conclusion: run.conclusion, name: run.name || "" } : null;

  return {
    ...base,
    ok: true,
    def,
    last: last ? { sha: last.sha.slice(0, 7), msg: last.commit.message.split("\n")[0], date: last.commit.author.date } : null,
    branches: compared,
    prs,
    ci,
    stale: pushedAt ? Date.now() - new Date(pushedAt).getTime() > 6048e5 : false,
  };
}

// ── Forge pipeline (public raw JSON — never rate-limited) ─────────────────
async function collectForge() {
  const f = cfg.forge;
  const ideasTxt = await rawText(f.repo, f.branch, f.ideasPath);
  const cfgTxt = await rawText(f.repo, f.branch, f.configPath);
  let ideas = [], config = null;
  try { ideas = ideasTxt ? (JSON.parse(ideasTxt).ideas || []) : []; } catch {}
  try { config = cfgTxt ? JSON.parse(cfgTxt) : null; } catch {}
  return { ideas, config };
}

// ── Owner action list (parsed from OVERSEER.md, same logic as the old client) ─
function parseActions(md) {
  const m = md.match(/owner action list[\s\S]*?\n([\s\S]*)$/i);
  if (!m) return [];
  const body = m[1].split(/\n##\s/)[0];
  const items = [];
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("- ")) items.push(line.replace(/^-\s+/, ""));
    else if (line && items.length) items[items.length - 1] += " " + line;
  }
  return items;
}

async function collectBrief() {
  const b = cfg.brief;
  const md = await rawText(b.repo, b.branch, b.path);
  if (md == null) return { actions: null, error: "Couldn't fetch OVERSEER.md" };
  return { actions: parseActions(md), error: null };
}

// ── Latest overseer run report ────────────────────────────────────────────
async function collectRun() {
  const listing = await api(`${cfg.runs.repo}/contents/${cfg.runs.path}`);
  if (!listing.ok) {
    if (listing.status === 404) return { run: null, error: null, note: "No runs yet." };
    return { run: null, error: `Couldn't read runs${listing.status ? ` (HTTP ${listing.status})` : ""}.` };
  }
  const files = Array.isArray(listing.data)
    ? listing.data.filter((f) => /^overseer-.*\.md$/.test(f.name)).sort((a, b) => (a.name < b.name ? 1 : -1))
    : [];
  if (!files.length) return { run: null, error: null, note: "No run reports yet." };
  const n = files[0];
  let excerpt = "";
  try {
    const res = await fetch(n.download_url);
    if (res.ok) excerpt = (await res.text()).split("\n").slice(0, 30).join("\n");
  } catch {}
  return { run: { name: n.name, html_url: n.html_url, excerpt }, error: null };
}

// ── Assemble ──────────────────────────────────────────────────────────────
const [active, support, labsRepos, forge, brief, run] = await Promise.all([
  Promise.all(cfg.active.map(collectRepo)),
  Promise.all(cfg.support.map(collectRepo)),
  Promise.all(cfg.labs.map((lr) => collectRepo({ ...lr, deploys: false, support: false }))),
  collectForge(),
  collectBrief(),
  collectRun(),
]);

// Join labs repo data with the matching forge idea (by repo name substring).
const labs = cfg.labs.map((lr, i) => {
  const repoData = labsRepos[i];
  const idea = forge.ideas.find((idObj) => idObj.repo && idObj.repo.toLowerCase().includes(lr.repo.toLowerCase())) || null;
  return { repo: lr.repo, emoji: lr.emoji, liveUrl: lr.liveUrl, repoData, idea };
});

const status = {
  generatedAt: new Date().toISOString(),
  owner: OWNER,
  authed: !!TOKEN,
  active,
  support,
  labs,
  forge,
  overseer: { actions: brief.actions, actionsError: brief.error, run: run.run, runError: run.error, runNote: run.note || null },
};

await mkdir(join(ROOT, "data"), { recursive: true });
await writeFile(join(ROOT, "data", "status.json"), JSON.stringify(status, null, 2) + "\n");

const okCount = [...active, ...support, ...labsRepos].filter((r) => r.ok).length;
const total = active.length + support.length + labsRepos.length;
console.log(`status.json written — ${okCount}/${total} repos OK, ${forge.ideas.length} forge ideas, generatedAt ${status.generatedAt}`);
