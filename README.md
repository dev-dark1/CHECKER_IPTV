# CHECKER IPTV

Premium IPTV checker and in-browser player built with:

- React + Vite + TypeScript
- TailwindCSS + Framer Motion
- Express proxy backend
- Railway backend deployment
- Vercel frontend deployment
- Neon/Supabase-compatible PostgreSQL persistence
- Optional Clerk authentication shell
- HLS.js, MPEGTS.js, and Shaka Player

## Runtime layout

Recommended production split:

- Vercel: frontend
- Railway: backend proxy + checker API + database connectivity
- Neon or Supabase Postgres: persistence

Set `VITE_API_BASE_URL` in Vercel to your Railway backend URL so the frontend never calls IPTV providers directly.

## Environment

Copy `.env.example` and fill in your real values:

- `VITE_API_BASE_URL`
- `VITE_CLERK_PUBLISHABLE_KEY`
- `PORT`
- `DATABASE_URL`
- `CLERK_SECRET_KEY`
- `SUPABASE_URL`
- `SUPABASE_KEY`
- `IPTV_CHECKER_ENDPOINT`
- `ALLOWED_ORIGINS`

## Local development

```bash
npm install
npm run dev
```

Frontend:

- `http://localhost:5173`

Backend:

- `http://localhost:4000`

## Production build

```bash
npm run build
```

## Database

Schema lives at:

- [db/schema.sql](./db/schema.sql)

When `DATABASE_URL` is configured, the backend automatically bootstraps the schema on startup and persists:

- playlists
- favorites
- recent views
- checker reports
- export events
- scan history
- stream diagnostics

## Backend endpoints

- `GET /health`
- `GET /api/health`
- `POST /api/check`
- `GET /proxy`
- `GET /proxy/probe`
- `GET /stream`
- `GET /m3u`
- `POST /api/player/fetch-url`
- `GET /api/player/cache/playlists`
- `POST /api/player/cache/playlist`
- `DELETE /api/player/cache/playlist/:id`
- `GET /api/player/cache/history`
- `POST /api/player/cache/history`
- `GET /api/player/cache/favorites`
- `POST /api/player/cache/favorites`
- `POST /api/checker/scan-history`
- `POST /api/checker/export`

## Notes

- The frontend player always goes through the backend proxy.
- Raw Xtream-style live links are normalized into browser-safe candidates before playback.
- The checker runs multiple validations in parallel for faster throughput.
- If Clerk keys are not configured, the app runs in guest mode without breaking the UI.
