// Stands in for the Android runtime: same wire protocol, synthetic data.
// Used to verify the MCP server and the timeline UI without a device attached.
//
//   node tools/mock-device.mjs
//
// The db and http traffic below mirrors what the real collectors emit — bind
// args recorded by PortholeStatement, body previews produced by PortholeInterceptor —
// so the tools and the UI get exercised against realistic shapes.
import net from "node:net";

const PORT = Number(process.env.PORT ?? 8677);
const started = Date.now();
const uptime = () => Date.now() - started + 12_000;

let seq = 0;
const ring = [];
const clients = new Set();

function emit(event, data) {
  const frame = { event, t: uptime(), seq: seq++, data };
  ring.push(frame);
  if (ring.length > 4096) ring.shift();
  const line = JSON.stringify(frame) + "\n";
  for (const socket of clients) socket.write(line);
}

// ---------------------------------------------------------------------------
// recompositions and state writes
// ---------------------------------------------------------------------------

const SCREENS = ["Cart", "Cart.TotalRow", "Cart.ItemRow", "Home"];
const KEYS = ["CartViewModel.items", "CartViewModel.promoCode", "<unnamed:SnapshotMutableStateImpl#3f2a1c>"];

setInterval(() => {
  const key = KEYS[Math.floor(Math.random() * KEYS.length)];
  emit("state_write", { keys: [key] });
  const burst = Math.random() < 0.2 ? 40 : 3;
  for (let i = 0; i < burst; i++) {
    const name = SCREENS[Math.floor(Math.random() * SCREENS.length)];
    emit("recompose", {
      id: `${name}#${(name.length * 7).toString(16)}`,
      name,
      screen: name.split(".")[0],
      pass: i + 1,
      triggeredBy: [key],
    });
  }
}, 900);

// ---------------------------------------------------------------------------
// database
//
// Reads come from PortholeDatabase.query, with args recovered by replaying
// SupportSQLiteQuery.bindTo into a recorder. Writes come from PortholeStatement,
// which records bind args as they are bound and reports the new row id or the
// affected row count afterwards.
// ---------------------------------------------------------------------------

const CART_ID = "88213";
const ITEMS = [
  { id: "mug-ceramic-01", name: "Ceramic Mug", qty: 2, price: 1800 },
  { id: "poster-a2-07", name: "A2 Poster", qty: 1, price: 2400 },
  { id: "tote-canvas-03", name: "Canvas Tote", qty: 1, price: 3200 },
];

const pick = (list) => list[Math.floor(Math.random() * list.length)];

const READS = [
  {
    sql: "SELECT `id`, `cart_id`, `name`, `qty`, `price_cents` FROM cart_items WHERE cart_id = ? ORDER BY added_at DESC",
    args: () => [CART_ID],
    ms: () => 8 + Math.random() * 30,
  },
  {
    sql: "SELECT COUNT(*) FROM cart_items WHERE cart_id = ?",
    args: () => [CART_ID],
    ms: () => 3 + Math.random() * 8,
  },
  {
    // The slow one, on purpose: something for a "why is this screen janky" hunt.
    sql: "SELECT `code`, `discount_pct`, `expires_at` FROM promo_codes WHERE code = ? AND expires_at > ?",
    args: () => ["SPRING25", String(Date.now())],
    ms: () => 40 + Math.random() * 180,
  },
];

const WRITES = [
  {
    sql: "INSERT OR REPLACE INTO cart_items (`id`,`cart_id`,`name`,`qty`,`price_cents`,`added_at`) VALUES (?,?,?,?,?,?)",
    args: () => {
      const item = pick(ITEMS);
      return [item.id, CART_ID, item.name, String(item.qty), String(item.price), String(Date.now())];
    },
    result: () => 412 + Math.floor(Math.random() * 40), // executeInsert: new row id
    ms: () => 6 + Math.random() * 25,
  },
  {
    sql: "UPDATE carts SET `total_cents` = ?, `item_count` = ?, `updated_at` = ? WHERE `id` = ?",
    args: () => [String(7400 + Math.floor(Math.random() * 2000)), "4", String(Date.now()), CART_ID],
    result: () => 1, // executeUpdateDelete: rows affected
    ms: () => 5 + Math.random() * 20,
  },
  {
    sql: "DELETE FROM cart_items WHERE `id` = ?",
    args: () => [pick(ITEMS).id],
    result: () => 1,
    ms: () => 4 + Math.random() * 12,
  },
  {
    sql: "UPDATE cart_items SET `qty` = ? WHERE `id` = ? AND `cart_id` = ?",
    args: () => [String(1 + Math.floor(Math.random() * 4)), ITEMS[0].id, CART_ID],
    result: () => 1,
    ms: () => 4 + Math.random() * 18,
  },
  {
    // Blobs are never included, only sized — see DbCapture.render.
    sql: "INSERT INTO cart_thumbnails (`item_id`,`webp`) VALUES (?,?)",
    args: () => [pick(ITEMS).id, "<blob 48213 bytes>"],
    result: () => 88 + Math.floor(Math.random() * 10),
    ms: () => 12 + Math.random() * 40,
  },
];

const READ_THREADS = ["arch_disk_io_0", "DefaultDispatcher-worker-3", "main"];
let dbId = 0;

function runQuery(spec, kind) {
  const id = "db-" + ++dbId;
  const args = spec.args();
  const elapsed = Math.round(spec.ms());
  const thread = kind === "write" ? "Room-Transaction-1" : pick(READ_THREADS);

  emit("db_start", { id, sql: spec.sql, kind, args: args.join(", ") });
  setTimeout(() => {
    const data = { id, sql: spec.sql, kind, elapsedMs: String(elapsed), thread, args: args.join(", ") };
    if (spec.result) data.result = String(spec.result());
    emit("db_end", data);
  }, elapsed);
}

setInterval(() => runQuery(pick(READS), "read"), 1700);
setInterval(() => runQuery(pick(WRITES), "write"), 3100);

// A failing write now and then, so the error path has something to show.
setInterval(() => {
  const id = "db-" + ++dbId;
  const sql = "INSERT INTO cart_items (`id`,`cart_id`) VALUES (?,?)";
  const args = "mug-ceramic-01, " + CART_ID;
  emit("db_start", { id, sql, kind: "write", args });
  setTimeout(
    () =>
      emit("db_end", {
        id,
        sql,
        kind: "write",
        elapsedMs: "11",
        thread: "Room-Transaction-1",
        args,
        error: "SQLiteConstraintException: UNIQUE constraint failed: cart_items.id (code 1555)",
      }),
    11,
  );
}, 17_000);

// ---------------------------------------------------------------------------
// http
//
// Previews match BodyPreview: text when captured, omittedReason when not.
// Sensitive headers arrive already replaced with "*" — BodyCapture redacts them
// in-process, before anything reaches the socket.
// ---------------------------------------------------------------------------

const CALLS = [
  {
    method: "GET",
    url: "https://api.example.com/v1/carts/88213?include=*",
    status: 200,
    requestHeaders: { accept: "application/json", authorization: "*" },
    responseHeaders: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    requestBody: null,
    responseBody: {
      contentType: "application/json; charset=utf-8",
      byteCount: 486,
      truncated: false,
      text: JSON.stringify({ id: CART_ID, itemCount: 4, totalCents: 9200, currency: "GBP", items: ITEMS }, null, 2),
    },
    ms: () => 180 + Math.random() * 900,
  },
  {
    method: "POST",
    url: "https://api.example.com/v1/carts/88213/items",
    status: 201,
    requestHeaders: { "content-type": "application/json", authorization: "*" },
    responseHeaders: { "content-type": "application/json; charset=utf-8" },
    requestBody: {
      contentType: "application/json",
      byteCount: 78,
      truncated: false,
      text: JSON.stringify({ sku: "mug-ceramic-01", qty: 2, giftWrap: false }, null, 2),
    },
    responseBody: {
      contentType: "application/json; charset=utf-8",
      byteCount: 164,
      truncated: false,
      text: JSON.stringify({ lineItemId: "li_8f21", cartTotalCents: 9200 }, null, 2),
    },
    ms: () => 240 + Math.random() * 700,
  },
  {
    method: "POST",
    url: "https://api.example.com/v1/checkout",
    status: 402,
    requestHeaders: { "content-type": "application/json", authorization: "*", "idempotency-key": "ik_2f81c0" },
    responseHeaders: { "content-type": "application/json; charset=utf-8" },
    requestBody: {
      contentType: "application/json",
      byteCount: 212,
      truncated: false,
      text: JSON.stringify({ cartId: CART_ID, paymentMethodId: "pm_1QxT", promoCode: "SPRING25" }, null, 2),
    },
    responseBody: {
      contentType: "application/json; charset=utf-8",
      byteCount: 141,
      truncated: false,
      text: JSON.stringify(
        { error: "card_declined", message: "Your card was declined.", declineCode: "insufficient_funds" },
        null,
        2,
      ),
    },
    ms: () => 600 + Math.random() * 1400,
  },
  {
    method: "GET",
    url: "https://cdn.example.com/products/mug-ceramic-01/hero.webp",
    status: 200,
    requestHeaders: { accept: "image/webp,image/*" },
    responseHeaders: { "content-type": "image/webp", "content-length": "48213" },
    requestBody: null,
    // What the interceptor produces for a body it declines to read.
    responseBody: {
      contentType: "image/webp",
      byteCount: 48213,
      truncated: false,
      text: null,
      omittedReason: "content type not captured",
    },
    ms: () => 120 + Math.random() * 400,
  },
  {
    // A one-shot streaming upload. The tee watches the bytes go to the socket,
    // so this is captured like any other body and the source is still read once.
    method: "PUT",
    url: "https://api.example.com/v1/carts/88213/notes",
    status: 200,
    requestHeaders: { "content-type": "application/json", "transfer-encoding": "chunked" },
    responseHeaders: { "content-type": "application/json" },
    requestBody: {
      contentType: "application/json",
      // Chunked, so no declared length: the byte count is what the tee counted.
      byteCount: 5312,
      truncated: true,
      text: JSON.stringify({ note: "gift wrap the mug", author: "james" }, null, 2),
    },
    responseBody: {
      contentType: "application/json",
      byteCount: 34,
      truncated: false,
      text: JSON.stringify({ ok: true }),
    },
    ms: () => 900 + Math.random() * 2200,
  },
  {
    // Duplex: the request body is written while the response is read, so there
    // is no point at which it is a finished thing to report.
    method: "POST",
    url: "https://api.example.com/v1/sync",
    status: 200,
    requestHeaders: { "content-type": "application/grpc+proto", "te": "trailers" },
    responseHeaders: { "content-type": "application/grpc+proto" },
    requestBody: {
      contentType: "application/grpc+proto",
      byteCount: -1,
      truncated: false,
      text: null,
      omittedReason: "duplex body: written while the response is read, never complete",
    },
    responseBody: {
      contentType: "application/grpc+proto",
      byteCount: -1,
      truncated: false,
      text: null,
      omittedReason: "content type not captured",
    },
    ms: () => 1500 + Math.random() * 3000,
  },
];

let httpId = 0;
const recentHttp = [];
// Keyed by id, like InflightCollector keys by Call: calls overlap, and a single
// slot mixes one call's fields into another's record.
const openCalls = new Map();

/** Matches InflightCollector: text snippet, or a note about why there is none. */
function snippet(body) {
  if (!body) return undefined;
  if (body.text != null) return body.text.slice(0, 512);
  return `<${body.omittedReason ?? "not captured"}, ${body.byteCount} bytes>`;
}

setInterval(() => {
  const spec = pick(CALLS);
  const id = "http-" + ++httpId;
  const startedAt = uptime();
  const elapsed = Math.round(spec.ms());

  emit("http_start", { id, method: spec.method, url: spec.url });
  const open = {
    id,
    method: spec.method,
    url: spec.url,
    startedAt,
    elapsedMs: 0,
    phase: "waiting",
    status: null,
    requestHeaders: spec.requestHeaders,
    responseHeaders: {},
    // While a body is still going out, the provider reports what has been
    // written so far rather than nothing.
    requestBody:
      spec.requestBody && spec.requestBody.text
        ? { ...spec.requestBody, byteCount: 0, text: "", omittedReason: "still uploading" }
        : spec.requestBody,
    responseBody: null,
  };
  openCalls.set(id, open);

  setTimeout(() => {
    recentHttp.push({
      ...open,
      elapsedMs: elapsed,
      phase: "done",
      status: spec.status,
      responseHeaders: spec.responseHeaders,
      // The upload has finished, so the provider now resolves to the real
      // preview rather than the in-progress one.
      requestBody: spec.requestBody,
      responseBody: spec.responseBody,
    });
    if (recentHttp.length > 25) recentHttp.shift();
    openCalls.delete(id);

    const data = {
      id,
      method: spec.method,
      url: spec.url,
      phase: "done",
      status: String(spec.status),
      elapsedMs: String(elapsed),
    };
    const request = snippet(spec.requestBody);
    const response = snippet(spec.responseBody);
    if (request) data.requestBody = request;
    if (response) data.responseBody = response;
    emit("http_end", data);
  }, elapsed);
}, 2600);

// ---------------------------------------------------------------------------
// navigation
// ---------------------------------------------------------------------------

const ROUTES = ["home", "cart", "cart/checkout"];
let routeIndex = 0;
setInterval(() => {
  routeIndex = (routeIndex + 1) % ROUTES.length;
  emit("nav", { route: ROUTES[routeIndex], label: "", args: "{}", depth: routeIndex + 1 });
}, 7000);

// ---------------------------------------------------------------------------
// rpc
// ---------------------------------------------------------------------------

const handlers = {
  hello: () => ({
    protocol: 1,
    packageName: "com.example.shop",
    processName: "com.example.shop",
    versionName: "1.4.2",
    debuggable: true,
    device: "Google Pixel 8",
    sdkInt: 35,
    startedAt: 12_000,
    collectors: ["recompositions", "semantics_tree", "state", "inflight", "nav_state", "workmanager"],
  }),
  recompositions: () => ({
    since: 0,
    now: uptime(),
    nodes: [
      {
        id: "Cart.ItemRow#4f21",
        name: "Cart.ItemRow",
        screen: "Cart",
        count: 341,
        firstAt: 14_000,
        lastAt: uptime(),
        triggeredBy: [
          { key: "CartViewModel.items", count: 338, named: true },
          { key: "<unnamed:SnapshotMutableStateImpl#3f2a1c>", count: 12, named: false },
        ],
      },
    ],
    unattributedWrites: [{ key: "<unnamed:DerivedSnapshotState#91b0>", count: 4, named: false }],
    notes: ["Counts cover instrumented call sites only."],
  }),
  semantics_tree: () => ({
    capturedAt: uptime(),
    merged: true,
    root: {
      nodeId: 1,
      stableId: "a1b2c3",
      role: null,
      testTag: null,
      text: null,
      contentDescription: null,
      bounds: { left: 0, top: 0, right: 1080, bottom: 2280 },
      actions: [],
      flags: [],
      children: [
        {
          nodeId: 8,
          stableId: "d4e5f6",
          role: "Button",
          testTag: "checkout#4f21",
          text: "Check out",
          contentDescription: null,
          bounds: { left: 40, top: 1900, right: 1040, bottom: 2020 },
          actions: ["OnClick"],
          flags: ["clickable", "merging"],
          children: [],
        },
      ],
    },
  }),
  nav_state: () => ({
    capturedAt: uptime(),
    graph: "root",
    current: {
      route: "cart/checkout",
      destinationId: "0x7f0a0123",
      label: null,
      args: { cartId: CART_ID },
      lifecycleState: "RESUMED",
      enteredAt: uptime() - 2000,
    },
    backStack: [
      { route: "home", destinationId: "0x7f0a0100", args: {}, lifecycleState: "STARTED" },
      { route: "cart", destinationId: "0x7f0a0110", args: { cartId: CART_ID }, lifecycleState: "STARTED" },
      { route: "cart/checkout", destinationId: "0x7f0a0123", args: { cartId: CART_ID }, lifecycleState: "RESUMED" },
    ],
    deepLink: { uri: "shop://cart/88213", action: "android.intent.action.VIEW", extras: {}, at: 12_400 },
  }),
  state: () => ({
    capturedAt: uptime(),
    owners: [
      {
        name: "CartViewModel",
        type: "com.example.shop.cart.CartViewModel",
        fields: [
          {
            key: "CartViewModel.items",
            kind: "MutableState",
            type: "ArrayList",
            value: { size: 3, items: ITEMS.map((item) => item.name) },
            attributable: true,
          },
          {
            key: "CartViewModel.promoCode",
            kind: "StateFlow",
            type: "String",
            value: "SPRING25",
            attributable: false,
          },
        ],
      },
    ],
  }),
  inflight: () => ({
    capturedAt: uptime(),
    http: [...openCalls.values()].map((c) => ({ ...c, elapsedMs: uptime() - c.startedAt })),
    queries: [],
    work: [
      {
        id: "e2b1",
        name: "SyncCartWorker",
        state: "RUNNING",
        tags: ["com.example.shop.SyncCartWorker"],
        runAttemptCount: 1,
      },
    ],
    recentHttp,
    notes: [],
  }),
  timeline: (params) => {
    const limit = params.limit ?? 1000;
    return { events: ring.slice(-limit), droppedBefore: 0, now: uptime() };
  },
  reset: () => ({ ok: true }),
};

net
  .createServer((socket) => {
    socket.setEncoding("utf8");
    clients.add(socket);
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (!line) continue;
        const request = JSON.parse(line);
        const handler = handlers[request.method];
        const response = handler
          ? { id: request.id, ok: true, result: handler(request.params ?? {}) }
          : { id: request.id, ok: false, error: `unknown method '${request.method}'` };
        socket.write(JSON.stringify(response) + "\n");
      }
    });
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => clients.delete(socket));
  })
  .listen(PORT, "127.0.0.1", () => console.log(`mock device on 127.0.0.1:${PORT}`));
