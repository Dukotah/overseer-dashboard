# overseer-dashboard

Live, phone-friendly status board for Dukotah's projects. A single static `index.html`
hosted free on GitHub Pages — **no server, no build**.

**Live:** https://dukotah.github.io/overseer-dashboard/

## How it works (the data pipeline)

The page reads **one pre-computed file, `data/status.json`** — it never calls the GitHub API
from the browser. A scheduled GitHub Action (`.github/workflows/refresh.yml`) runs
`scripts/collect.mjs` every ~10 minutes, gathers every project's GitHub-side state **server-side**
using the Action's built-in token, and commits a fresh `data/status.json`.

> **Why:** unauthenticated browser calls to the GitHub API are capped at **60/hour per IP**, and a
> single dashboard load fanned out to far more than that across every repo — so the old
> read-from-the-browser approach hit the rate-limit wall and broke. Pre-computing server-side (5000/hr
> authenticated, one static file to the browser) removes the limit entirely and makes the page load instantly.

Shows, for every project: default branch, last commit, unmerged branches (with ahead/behind counts),
open PRs, CI status, any `overseer/<date>` review branches, the Copper Bay Labs products, the **forge
idea pipeline** (from `forge/ideas.json`), the **owner-action list** (parsed from
`Dukotah/master-prompts/OVERSEER.md`), and the latest overseer run report.

It reflects **GitHub-side state only** — it cannot see your laptop's uncommitted/unpushed work.
For that, run `~/overseer-status.mjs` (a.k.a. `overseer.bat`) locally.

## Config

Edit `repos.json` to add/remove tracked repos, Labs products, or change sources. The collector and the
page both key off it (the page via the generated `status.json`).

## Private repos (optional)

The Action's built-in `GITHUB_TOKEN` reads all **public** repos plus this repo's own privates. To also
surface other **private** repos (e.g. `apex-trader`), create a fine-grained read-only Personal Access
Token and add it as a repo secret named `DASHBOARD_PAT`; the collector uses it automatically.

Companion to the daily remote routine that coordinates the projects (see OVERSEER.md §0–§3).
