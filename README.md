# overseer-dashboard

Live, phone-friendly status board for Dukotah's projects. A single static `index.html`
that reads the **GitHub API directly from the browser** — no server, no build, hosted free
on GitHub Pages.

**Live:** https://dukotah.github.io/overseer-dashboard/

Shows, for every project: default branch, last commit, any `overseer/<date>` branches awaiting
review, plus the **owner-action list** parsed live from `Dukotah/master-prompts/OVERSEER.md` and the
latest overseer run report. Auto-refreshes every 5 minutes.

It reflects **GitHub-side state only** — it cannot see your laptop's uncommitted/unpushed work.
For that, run `~/overseer-status.mjs` (a.k.a. `overseer.bat`) locally.

Companion to the daily remote routine that coordinates the projects (see OVERSEER.md §0–§3).
