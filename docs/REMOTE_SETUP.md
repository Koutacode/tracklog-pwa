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

### Google admin login and callback URLs

1. In Supabase Dashboard, open **Authentication > Sign In / Providers > Google**, enable the provider, and set the Google OAuth client ID and client secret.
2. Copy the Supabase callback URL shown on that provider page. It has the form:
   - `https://<project-ref>.supabase.co/auth/v1/callback`
3. In Google Auth Platform, create a **Web application** OAuth client and add that exact Supabase callback URL to **Authorized redirect URIs**. Google redirects to Supabase first; do not enter the TrackLog web or native callback here.
4. In Supabase Dashboard, open **Authentication > URL Configuration** and append these TrackLog destinations to **Redirect URLs**:
   - Web admin callback: `https://tracklog-assist.pages.dev/auth/admin/callback`
   - Web driver callback: `https://tracklog-assist.pages.dev/auth/driver/callback`
   - Android native callbacks: `com.tracklog.assist://**`

Keep every existing redirect entry used by the `gptsites` location-sharing site. The TrackLog URLs above are additions; do not replace or remove the existing `gptsites` URLs. After saving, confirm the Google provider remains enabled and test both the PWA and Android login flows.

## Cloudflare Pages

1. Build with `npm run build`.
2. Deploy with `npm run deploy:pages`.
3. Confirm SPA routing via `public/_redirects`.

## Initial admin

The default admin email is `matumurak0623@gmail.com`.
