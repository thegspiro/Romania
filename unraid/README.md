# Unraid Community Applications templates

Two container templates, so this application can be installed the way an Unraid
user expects rather than only from a shell.

| Template                  | Role                                                 |
| ------------------------- | ---------------------------------------------------- |
| `dissertation-web.xml`    | Serves the site; applies migrations on start         |
| `dissertation-worker.xml` | Compilation, backups, derivatives, geocoding, Zotero |

Both point at `ghcr.io/thegspiro/romania:latest` and differ only in
`<PostArgs>`, which is the entrypoint's first argument and selects the role.
That is the same shape authentik uses on CA — one image, `server` and `worker`
templates, an external database.

## What a template cannot express

A Community Applications template describes **one container**. This application
is three: web, worker, and MySQL. So these templates cannot wire the stack
together, and three things have to be kept in step by hand:

- **The database**, which you install separately and point both containers at.
- **The `/data/files` host path**, which must be _identical_ in both. The web
  app stages an assembled manuscript there and the worker reads it back; if the
  paths differ, compilation produces nothing and says nothing.
- **The uid.** The image runs as 1000 and has no `PUID`/`PGID` — the uid is
  fixed at build time. Unraid shares are `nobody:users` (99:100), so the
  directories need `chown -R 1000:1000` before first start.

`docker-compose.yml` plus `docker-compose.unraid.yml` express all of that in
one command, which is why they remain the documented path in
[`../docs/unraid.md`](../docs/unraid.md). These templates are the alternative,
not the replacement: they trade a wiring step you cannot get wrong for three
you can.

## Keeping them current

The templates pin nothing but `:latest`, so an image published by CI reaches
an Unraid box on the next container update — no edit here required. What does
need editing here is a change to the _shape_ of a deployment: a new required
environment variable, a new mount, a changed port. `.env.example` is the source
of truth for configuration; when a required value is added there, add a
`<Config>` entry to whichever of these templates needs it.

`<TemplateURL>` points at the raw file on `main`, which is how CA picks up such
a change after it merges.

## Getting them listed

Not done, and not something this repository can do on its own: Community
Applications lists templates from repositories its maintainers have added to
the application feed, which is a submission made by a person with an Unraid
forum account.

**The current submission procedure was not verified when these templates were
written** — the CA policy documentation could not be reached from the
environment they were written in. Check the Community Applications support
thread on the Unraid forum for what the process is now, rather than trusting a
remembered version of it.

Until that submission happens these files are still useful: the Unraid Docker
tab can add a container from a template URL directly, so they can be used as-is
by pointing at the raw URLs above.
