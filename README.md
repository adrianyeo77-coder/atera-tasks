# Atera Tasks

A shared Todoist-style task app for the Atera Water team. Static frontend (vanilla JS) talking to Supabase (Postgres + Auth + Realtime).

- **Live:** https://adrianyeo77-coder.github.io/atera-tasks/
- Accounts are email + password; sign up on the login screen.
- Data lives in the team Supabase project under the isolated `tasks_app` schema. Access is enforced by Row Level Security.
- `config.js` holds the project URL + **publishable** key only — both public by design.

To deploy an update: edit the files and push to `main`; GitHub Pages redeploys automatically.
