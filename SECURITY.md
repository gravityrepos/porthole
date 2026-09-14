# Security

Porthole reads things that matter: request and response bodies, SQL with the
values bound into it, your app's logcat, and the current contents of your state.
It is worth being precise about where that goes.

## Reporting a vulnerability

Use GitHub's [private vulnerability
reporting](https://github.com/gravityrepos/porthole/security/advisories/new) on
this repository. It does not create a public issue.

Please do not open a public issue for anything that looks like a disclosure
problem. Everything else — crashes, wrong numbers, missing lanes — is an
ordinary bug and a normal issue is the right place.

Expect an acknowledgement within a few days. If a fix is warranted it will ship
with an advisory naming the versions affected.

## Where the data goes

Nowhere, unless you send it there.

- The socket binds to `127.0.0.1` and nothing else. There is no outbound
  connection anywhere in the runtime, no telemetry, and no analytics.
- Reaching it from off-device needs `adb forward`, which needs USB debugging
  authorisation.
- The timeline UI and the MCP server both run on your machine and talk to that
  forwarded port.
- The project's website is a separate thing from the tool, and the "no
  analytics" above is a claim about the runtime, not about the site: the
  landing page carries Vercel Web Analytics, which is first-party and
  cookieless — the script and the beacon it sends are both same-origin, and
  the page's `script-src 'self'; connect-src 'self'` policy means nothing on
  it talks to another host at all.

## The workstation timeline server

The MCP server's timeline UI (`mcp/src/timeline.ts`, `TimelineServer`) is a
second HTTP server, distinct from the on-device socket above, and it holds
the same event buffer the UI renders — so it is worth being just as precise
about its boundary.

It binds `127.0.0.1` only, same as the device. That keeps the network out but
not the browser: every page open on your machine can already reach
`127.0.0.1`, and a cross-origin request — or a WebSocket upgrade — lands
whether or not the page making it can read the reply. Two checks close that,
applied to every request before any routing, on the WebSocket upgrade as well
as on ordinary HTTP: the `Host` header must name one of this server's own
addresses (its loopback spellings, plus the Vite dev port when the UI is
proxied through it), and a request that also carries an `Origin` must have
that origin agree with the `Host` it named — a caller may claim to be
`http://127.0.0.1:8678`, but only when it was also addressed to
`127.0.0.1:8678`. Both a page on the open web (wrong `Host`) and a page
served from an allowed port but under a different origin (`Origin` disagrees
with `Host`) are refused with a 403 before the request reaches anything that
reads the event buffer.

What this does not yet have is a session token: a value minted at start,
printed in the URL the CLI opens, and required on every call, which would
close the one gap the origin check cannot — a same-origin page loaded by
accident (a stale tab, a bookmark) rather than one from elsewhere. That is
deferred, not implemented. The origin/host check above is what currently
stands between the timeline server and a request that isn't the UI.

A trace leaves your control only when you choose to send it — pasting a report
into a ticket, or handing a window to an assistant with **ask agent**. That is
the moment the redaction below matters.

`capture_system_trace` is a different kind of artifact from everything else
here, and worth calling out on its own. It is a Perfetto capture of the whole
device for the recorded window, not just this app — process names, thread
names and scheduling for whatever else was running are in it, because
Perfetto records at the kernel level and none of that is Porthole's to
filter. What Porthole does control is its own contribution: the spans it
writes into that same trace are named by shape (`db SELECT cart_items`,
`http GET api.example.com/checkout`), never by argument or full URL, so
nothing the redaction below covers reaches the trace through them. The file
itself is written to disk under `.porthole/traces/`, which makes it a
persistent artifact rather than something held only in memory until asked
for — treat it like a screenshot: it stays on your machine, with the rest of
the device's activity in it, until you choose to open it or hand it to
someone.

## What is redacted, before anything leaves the process

- **Query-string values** are replaced with `*`, keeping the parameter names.
  Everything is stripped rather than a list of known-sensitive names: a
  deny-list is only as good as its last update, and the time it is out of date
  is the time it matters.
- **Sensitive headers** — `authorization`, `proxy-authorization`, `cookie`,
  `set-cookie`, `x-api-key`, `x-auth-token` — are replaced with `*`.
- **Request and response bodies are not captured at all** unless you ask for
  them with `installPorthole(bodies = BodyCapture.Text)`.
- **Database bind values are captured by default**, because a write with its
  values stripped tells you almost nothing. Pass `captureBindArgs = false` if
  the database holds something you would rather never have in a trace; the SQL,
  timings and thread still come through.
- **Blobs are never included**, only their size.

Logcat is the one collector that forwards whatever the app printed, including
anything logged that should not have been. It is debug-only and loopback-only
like everything else.

## Release builds

The runtime is debug-only. Release builds link `runtime-noop`, which has the
same public API with empty bodies: no socket, no collectors, no reflection, no
interceptor added, no open helper wrapped. Instrumentation can stay in
production code and compile to nothing.

An API parity test compares the public surface of the two modules, so a new
integration cannot ship in the real runtime without a no-op counterpart.

## Things that are working as intended

Reports of these are welcome as questions, but they are not vulnerabilities:

- **The socket is reachable from the device itself.** Anything already running
  as your app's user, or with adb access to the device, has more direct routes
  to the same data. The porthole does not widen that.
- **The debug build exposes app internals.** That is the entire purpose. The
  boundary that matters is that release builds do not.
- **The database inspector can read any table in the app's own database.** So
  can the app.

## Things that would be

- Anything from the runtime appearing in a **release** build.
- **Redaction failing** — a token, a cookie or a query-string value reaching the
  socket unmasked.
- The socket **binding to anything other than loopback**, or accepting a
  connection from off-device without `adb forward`.
- The **database inspector executing a write**. It accepts a single SELECT, a
  WITH, or a PRAGMA with no assignment in it, enforced on the device rather than
  assumed from the socket being local.
- The runtime **sending anything outbound**.
- A **capture or trace file containing data the UI redacted**.

## Verifying the redaction yourself

The sample sends a bearer token, a query-string token and a `Set-Cookie`, all
containing the string `do-not-log`. Run it, exercise the buttons, and search
everything the porthole emitted:

```bash
curl -s http://127.0.0.1:8678/api/events | grep -c do-not-log
```

It should be `0`. That is the check used on this repo, and it is worth repeating
against your own app's traffic before you trust a trace enough to paste it
somewhere.
