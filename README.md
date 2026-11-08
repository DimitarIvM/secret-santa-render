# Secret Santa (Render.com)

A random-draw Secret Santa wheel. Everyone stays on the wheel, nobody can be drawn twice, and only you can see who you got.

## Deploy
1. Push this folder to a new GitHub/GitLab repo.
2. In Render: **New → Blueprint**, pick the repo. `render.yaml` creates a web service and a free Postgres database.
3. After the first deploy, open the service → **Environment** and copy `ADMIN_PASSWORD` (auto-generated).
4. Open your `onrender.com` URL → **Organizer** → enter the password and the names → **Create game**.
5. Send the URL to everyone. Each person picks their name, chooses a PIN, and spins.

## Notes
- Free web services sleep after ~15 min idle (first load can take about a minute). Free Postgres expires after 30 days, which is plenty for a Secret Santa.
- Only one free Postgres is allowed per Render workspace. If you already have one, change `plan: free` for the database to a paid plan in `render.yaml`.
- Local test: `ADMIN_PASSWORD=secret npm start` (stores data in `./data/game.json` when `DATABASE_URL` is not set).
- **Reset game** (Organizer panel) erases names, PINs and draws.
