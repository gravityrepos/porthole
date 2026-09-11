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

A trace leaves your control only when you choose to send it — pasting a report
into a ticket, or handing a window to an assistant with **ask agent**. That is
the moment the redaction below matters.

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
