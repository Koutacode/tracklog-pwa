# TrackLog Remote Setup

## Required services

- Supabase project
- Cloudflare Pages project

## Env vars

Create an untracked `.env.local` and set:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

## Supabase

1. Create a new Supabase project.
2. Enable:
   - Anonymous sign-ins
   - Magic link email sign-in
3. Apply all project migrations in order to this new environment, starting with
   `supabase/migrations/20260329_tracklog_remote.sql`. The initial file alone is
   not a complete current installation. Then follow **Initial admin** below.

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

There is no default administrator in source control. Administration continues to use
Google sign-in and the enabled rows in `public.admin_users`; a client environment
variable does not grant access.

### Existing environments: no action

This source-only removal of the initial seed does not change an already provisioned
database. Keep the existing `admin_users` rows and Google configuration. Do not rerun
the historical migration, reset the database, re-register the administrator, or
change permissions to apply this documentation change. Production login must be
checked separately with the existing account; local tests do not prove live access.

### New environments only

1. Apply the project's migrations in order to a new, isolated environment. The
   historical initial SQL alone is not a complete current installation; later
   migrations include authorization hardening. Keep their RLS and grants intact.
2. Before opening administration to users, configure Google as described above.
3. A project administrator must review and run the following one-time bootstrap in
   the **new environment's** trusted SQL editor. First verify the project identity
   and that `admin_users` is empty. Replace the example address in a private copy
   with the intended Google account's verified email. Do not commit that copy,
   publish the email in a PR, or put it in a `VITE_*` variable.

```sql
-- New, empty environments only. The unmodified example fails closed.
do $$
declare
  bootstrap_email text := 'admin@example.invalid';
begin
  bootstrap_email := lower(btrim(bootstrap_email));
  if bootstrap_email is null or bootstrap_email = ''
     or bootstrap_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
     or bootstrap_email like '%@example.invalid' then
    raise exception 'Set the intended verified Google email in a private copy';
  end if;
  -- Serialize setup attempts before checking that this is an empty environment.
  lock table public.admin_users in exclusive mode;
  if exists (select 1 from public.admin_users) then
    raise exception 'Existing environment: leave administrator settings unchanged';
  end if;
  insert into public.admin_users (email, enabled)
  values (bootstrap_email, true);
end;
$$;
```

4. In that isolated environment, confirm exactly the intended administrator is
   enabled, then test Google login and the admin page. An unregistered account must
   be denied. An empty table intentionally denies administration until bootstrap is
   complete. Do not resolve a failure by weakening RLS or adding a client bypass.

The bootstrap is deliberately refused for a nonempty table, including disabled
accounts; it is not an account recovery or production update procedure. This PR
only documents it and does not execute it against any remote database.
