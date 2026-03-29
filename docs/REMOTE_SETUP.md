# TrackLog Remote Setup

## Required services

- Supabase project
- Cloudflare Pages project

## Env vars

Copy `.env.example` to `.env.local` and set:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_TRACKLOG_ADMIN_EMAIL`

## Supabase

1. Create a new Supabase project.
2. Enable:
   - Anonymous sign-ins
   - Magic link email sign-in
3. Run the SQL in `supabase/migrations/20260329_tracklog_remote.sql`.

## Cloudflare Pages

1. Build with `npm run build`.
2. Deploy with `npm run deploy:pages`.
3. Confirm SPA routing via `public/_redirects`.

## Initial admin

The default admin email is `matumurak0623@gmail.com`.

