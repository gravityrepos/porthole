# @gravitylabsllc/porthole

The workstation half of [Porthole](https://porthole.gravitylabs.live): an MCP server
and a live timeline for a running Android app.

Porthole is a debug-only agent that lives inside your app and answers questions about
it while it runs — what recomposed and why, which frames were dropped and where the
time went, what is holding the main thread, what is in flight, what your state
actually contains right now. This package is what connects to it: a browser timeline
for a person watching their own app, and an MCP server for a coding assistant that
can read the answers and go change the code that caused them.

The agent itself is an Android library. It is not in this package, and nothing here
returns data until it is running: add the Gradle plugin `live.gravitylabs.porthole`
to your app module, install a debug build, and then come back here. Setup is in the
[repository README](https://github.com/gravityrepos/porthole#setup).

## The timeline

```bash
npx @gravitylabsllc/porthole ui
```

That forwards the device port with `adb`, serves the timeline, opens your browser and
keeps running until you stop it. It needs Node 18 or newer and `adb` — from
`ANDROID_HOME`, a `local.properties` above the working directory, or your PATH.

## The MCP server

`./gradlew portholeMcpConfig` writes this entry for you, merging rather than
overwriting. To paste it into `.mcp.json` yourself:

```json
{
  "mcpServers": {
    "porthole": {
      "command": "npx",
      "args": ["-y", "@gravitylabsllc/porthole"],
      "env": { "PORTHOLE_PORT": "8677" }
    }
  }
}
```

The tools it registers:

| tool | answers |
| --- | --- |
| `findings` | start here: what is wrong right now, ranked, each with the tool that shows its evidence |
| `recompositions` | which composables recomposed, how often, and which state keys were written just before |
| `semantics_tree` | the semantics tree with an id that stays stable across captures |
| `nav_state` | back stack, arguments on each entry, and the deep link that got you here |
| `state` | current values of your ViewModel state, named automatically |
| `inflight` | open HTTP calls with the phase each is stuck in, running queries, WorkManager jobs |
| `frames` | dropped frames, and which phase of the frame ate the time |
| `blocking` | what held the main thread, with the stack it was stuck in |
| `logs` | the app's own logcat output, stack traces intact, without touching adb |
| `timeline` | the raw event stream, for ordering things relative to each other |
| `what_was_happening` | the narrative for one instant: screen, in-flight work, main thread, state just written |
| `system_context` | thermal state, CPU governor, busiest processes, memory pressure |
| `capture_system_trace` | records a Perfetto trace, annotated with the app's own spans |
| `ask_system_trace` | puts a fixed set of questions to a captured trace, to rule causes in or out |
| `open_timeline` | opens the live timeline in the browser |
| `porthole_status` | whether any of the above can currently reach the device |

## The two binaries

`porthole` is the CLI, for a person:

```
porthole ui                                       open the live timeline
porthole capture --scenario <name> -- <command>   record a run to a trace
porthole report <trace.json>                      what the run is worth looking at
porthole compare <base> <trace>                   regressions against a baseline
porthole mcp                                      the MCP server (stdio)
```

`porthole-mcp` is that last line as its own entry point, for MCP clients that want a
bare command rather than a subcommand. The two are the same server.

## Environment

| variable | default | what it sets |
| --- | --- | --- |
| `PORTHOLE_HOST` | `127.0.0.1` | host the forwarded device socket is reachable on |
| `PORTHOLE_PORT` | `8677` | device port the porthole listens on |
| `PORTHOLE_UI_PORT` | `8678` | port the timeline is served on |
| `PORTHOLE_TRACE_PROCESSOR` | none | path to Perfetto's `trace_processor`, for system traces |

The MCP server and the timeline are independent. Run either, or both at once — they
each open their own connection to the device.

## More

- [porthole.gravitylabs.live](https://porthole.gravitylabs.live) — what it is, with pictures
- [github.com/gravityrepos/porthole](https://github.com/gravityrepos/porthole) — the full documentation: setup, what the numbers mean, what gets captured and what does not, security

## License

Apache License 2.0. Copyright 2026 Gravity Labs.
