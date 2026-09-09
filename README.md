# Usage-Based API Platform

A service that provisions mock model deployments, meters authenticated
completion requests against them, and reports aggregated usage and cost.

Node.js 20 · TypeScript · Fastify 5 · MongoDB 6 · Vitest

**Design document:** [`docs/superpowers/specs/2026-09-09-usage-metering-platform-design.md`](docs/superpowers/specs/2026-09-09-usage-metering-platform-design.md)

---

## 1. Setup and run

Requires Node.js 20 or newer (`node -v`). No database installation needed.

```bash
npm install
npm run dev          # http://localhost:3000
```

When `MONGODB_URI` is unset, the service boots an in-process MongoDB for you.
**First run only:** `mongodb-memory-server` downloads a `mongod` binary
(~100 MB) into `~/.cache/mongodb-binaries`, so the first `npm run dev` or
`npm test` needs network access and takes a minute. Two ways to skip that:

```bash
# Use any MongoDB you already have
MONGODB_URI=mongodb://localhost:27017 npm run dev

# Or start one with the bundled compose file
docker compose up -d mongo
MONGODB_URI=mongodb://localhost:27017 npm run dev
```

Tests and typecheck:

```bash
npm test         # 71 tests across 11 files, ~35s
npm run typecheck
npm run build
```

Every configuration value has a working default — see [`.env.example`](.env.example).
Useful ones for poking at the service: `PROVISIONING_MS` (default `10000`) and
`RATE_LIMIT_PER_MINUTE` (default `100`).

### Walkthrough

Every command below was run against the built service. Start it with a short
provisioning window so you are not waiting ten seconds:

```bash
npm run build
PROVISIONING_MS=2000 node dist/index.js
```

**Create a deployment.** Returns immediately; provisioning is asynchronous.

```bash
curl -sX POST localhost:3000/deployments \
  -H 'content-type: application/json' \
  -d '{"model":"model-a"}'
# {"deployment_id":"dep_oz0oaq1cnztsfcjm","status":"provisioning"}
```

```bash
DEP=dep_oz0oaq1cnztsfcjm   # substitute your own id
```

**Read it while provisioning.** No `endpoint_url`, no `api_key` — an unready
deployment must not hand out a usable credential.

```bash
curl -s localhost:3000/deployments/$DEP
# {"deployment_id":"dep_oz0…","model":"model-a","status":"provisioning",
#  "created_at":"2026-09-09T19:00:36.276Z","terminated_at":null}
```

**Read it once ready.**

```bash
sleep 3
curl -s localhost:3000/deployments/$DEP
# {"deployment_id":"dep_oz0…","model":"model-a","status":"ready",
#  "created_at":"…","terminated_at":null,
#  "endpoint_url":"http://localhost:3000/v1/dep_oz0oaq1cnztsfcjm",
#  "api_key":"sk_uU3E0TsNbG0nPxQ02Dz4p3ip2ssGaibM"}
```

```bash
KEY=sk_uU3E0TsNbG0nPxQ02Dz4p3ip2ssGaibM
```

`endpoint_url` is the URL to call, not a placeholder.

**Make a metered request.**

```bash
curl -sX POST localhost:3000/v1/$DEP/completions \
  -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' \
  -d '{"prompt":"write a haiku about billing"}'
# {"output":"mocked response","input_tokens":7,"output_tokens":111}
```

**Read the bill.**

```bash
curl -s "localhost:3000/usage?api_key=$KEY&group_by=model"
```

```json
{
  "api_key_prefix": "sk_c6AjLEwd",
  "range": { "from": "2026-08-11T00:00:00.000Z", "to": "2026-09-10T00:00:00.000Z" },
  "group_by": "model",
  "pricing": { "input_per_1k_usd": "0.001", "output_per_1k_usd": "0.002" },
  "totals": {
    "requests": 3, "input_tokens": 15, "output_tokens": 372,
    "total_tokens": 387, "cost_micro_usd": 759, "cost_usd": "0.000759"
  },
  "breakdown": [
    { "key": "model-b", "requests": 3, "input_tokens": 15, "output_tokens": 372,
      "total_tokens": 387, "cost_micro_usd": 759, "cost_usd": "0.000759" }
  ]
}
```

That report reconciles exactly with the three requests that produced it:
input `10 + 1 + 4 = 15`, output `104 + 112 + 156 = 372`, and
cost `15 + 2 × 372 = 759` micro-USD.

`group_by=day` returns the same shape with `"key": "2026-09-09"` buckets.
Both `from` and `to` accept ISO 8601 and may be omitted.

**Every rejection.** Observed status codes, in the order the service checks them:

```bash
# 401 — no credential
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:3000/v1/$DEP/completions \
  -H 'content-type: application/json' -d '{"prompt":"hi"}'
# 401

# 401 — wrong scheme or unknown key
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:3000/v1/$DEP/completions \
  -H "authorization: Token $KEY" -H 'content-type: application/json' -d '{"prompt":"hi"}'
# 401

# 403 — a valid key aimed at a deployment it does not own
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:3000/v1/$OTHER/completions \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' -d '{"prompt":"hi"}'
# 403

# 403 — deployment that does not exist (see trade-offs; deliberately not 404)
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:3000/v1/dep_nope/completions \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' -d '{"prompt":"hi"}'
# 403

# 400 — empty prompt
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:3000/v1/$DEP/completions \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' -d '{"prompt":""}'
# 400

# 404 — unknown deployment on the control plane
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/deployments/dep_nope
# 404

# 409 — terminated (or still provisioning)
curl -sX DELETE localhost:3000/deployments/$DEP > /dev/null
curl -s -X POST localhost:3000/v1/$DEP/completions \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' -d '{"prompt":"hi"}'
# {"error":{"code":"deployment_not_ready",
#           "message":"Deployment dep_… is terminated; it must be ready to serve requests.",
#           "request_id":"req_x3g2nv4g6o9n"}}
```

**429.** Easiest to see with a small limit:

```bash
RATE_LIMIT_PER_MINUTE=5 PROVISIONING_MS=1000 node dist/index.js
# …create a deployment, then send seven requests:
# 1..5 -> 200, 6 -> 429, 7 -> 429
```

```
HTTP/1.1 429 Too Many Requests
retry-after: 13
x-ratelimit-limit: 5
x-ratelimit-remaining: 0
x-ratelimit-reset: 1788980640

{"error":{"code":"rate_limit_exceeded",
          "message":"Rate limit of 5 requests per minute exceeded.",
          "request_id":"req_ajc0ok41hxh8"}}
```

`GET /usage` then reports exactly `5` requests. Rejected requests are never billed.

`X-Account-Key` is accepted on `POST /deployments` and falls back to a seeded
demo tenant, so none of the commands above need account setup. An
`Idempotency-Key` header on a completion makes a retry replay the stored event
instead of charging twice.

Every non-2xx response uses one envelope:

```json
{ "error": { "code": "deployment_not_ready", "message": "…", "request_id": "req_…" } }
```

`code` is the stable contract (`invalid_api_key`, `key_deployment_mismatch`,
`deployment_not_ready`, `rate_limit_exceeded`, `validation_failed`, `not_found`,
`internal_error`); `message` is for humans. `request_id` is echoed in the
`x-request-id` response header too, and honours a caller-supplied one.

---

## 2. Data model

Five collections, with custom string `_id` values (`dep_…`, `key_…`, `evt_…`)
rather than `ObjectId` — these ids appear in URLs and responses, so a typed
prefix makes a misrouted id obvious at a glance.

```js
// tenants
{ _id: "ten_…", name, account_key_hash, created_at }

// deployments
{ _id: "dep_…", tenant_id, model: "model-a"|"model-b",
  status: "provisioning"|"ready"|"terminated",
  ready_at: Date|null,          // provisioning deadline
  endpoint_url: string|null,    // null until ready
  created_at, updated_at, terminated_at }

// api_keys
{ _id: "key_…", deployment_id, tenant_id,
  key_hash,     // sha256(secret) — the field auth looks up
  key_prefix,   // "sk_c6AjLEwd" — safe for logs and display
  secret,       // plaintext; see Assumption 1
  revoked_at, created_at }

// usage_events — immutable ledger
{ _id: "evt_…", tenant_id, deployment_id, api_key_id,
  model,                   // snapshot, not a join
  input_tokens:   Int32,
  output_tokens:  Int32,
  cost_micro_usd: Int32,   // frozen at write time
  occurred_at, request_id }

// rate_limit_buckets — ephemeral, TTL-expired
{ _id: "<api_key_id>:<epoch_minute>", count: Int32, expires_at }
```

Indexes:

```js
usage_events:        { tenant_id: 1, occurred_at: 1 }     // tenant aggregation
                     { api_key_id: 1, occurred_at: 1 }    // GET /usage
                     { request_id: 1 }  unique            // idempotency
deployments:         { status: 1, ready_at: 1 }           // sweeper scan
                     { tenant_id: 1, created_at: -1 }
api_keys:            { key_hash: 1 }  unique              // auth lookup
                     { deployment_id: 1 }
tenants:             { account_key_hash: 1 }  unique
rate_limit_buckets:  { expires_at: 1 }  expireAfterSeconds: 0
```

### Why this shape

**Money is integer micro-USD, and the given prices land exactly.**
`$0.001 per 1,000 input tokens` is **1 micro-USD per input token**;
`$0.002 per 1,000 output tokens` is **2 micro-USD per output token**. So
`cost = input × 1 + output × 2` — exact integer arithmetic, no float anywhere in
the billing path. Even the dollar string is produced by integer division and
padding rather than `(n / 1e6).toFixed(6)`.

**Cost is frozen at write time.** If pricing changes tomorrow, historical bills
must not change. Storing the computed cost on the event makes the ledger
immutable and reduces aggregation to `$sum`.

**`tenant_id` and `model` are denormalized onto usage events.** A usage event is
a financial record, not a normalized entity — it must stay true even if the
deployment is later mutated or deleted. It also lets the aggregation run as a
`{ tenant_id, occurred_at }` range scan with no `$lookup`, which is the property
that matters at high write volume.

**`key_hash` plus `key_prefix`.** Authentication is a single exact lookup on a
unique index; logs and reports carry only the prefix. There is deliberately no
timing-safe comparison in the code: the match happens inside the database as an
index lookup and no application branch depends on the secret's bytes, so there
is no secret-dependent timing channel of ours to close.

**Integer BSON types are enforced, not assumed.** The `$jsonSchema` validators
require `bsonType: "int"` on all three billing columns, and tests assert the
stored type with `{ $type: "int" }`. If the driver ever wrote a double, the
insert would fail loudly rather than quietly corrupting a bill. The validators
also enforce the `model` and `status` enums, so an invalid state is refused by
the database and not only by Zod.

**Multi-tenancy.** The ownership chain is
`tenant → deployment → api_key → usage_event`, and `tenant_id` is the leading
field of the primary usage index. The spec defines no account concept, so
`X-Account-Key` is optional and falls back to a seeded `demo` tenant. Turning
this into real tenant isolation means making that header required and scoping
each query by the resolved `tenant_id` — the fields and indexes are already there.

### State machine

```
                 ready_at reached
  provisioning ───────────────────▶ ready
       │                              │
       │  DELETE                      │  DELETE
       ▼                              ▼
   terminated ◀───────────────────────┘
       │
       └── DELETE (idempotent, no-op)
```

`ready_at` is **persisted at creation**, not scheduled with `setTimeout`, so a
restart cannot lose it and no instance owns a deployment. Status is written
forward by a background sweeper and, as a safety net, on read. Both go through
the same conditional update, so concurrency is resolved by the query filter:

```js
// provisioning -> ready
{ _id, status: "provisioning", ready_at: { $lte: now } }

// terminate — 'terminated' is absorbing, so DELETE always wins
{ _id, status: { $ne: "terminated" } }
```

If two sweepers run, or a sweeper and a `DELETE` collide in the same
millisecond, exactly one update matches. Invalid transitions are rejected by the
filter rather than by an `if` that could race. A test terminates a deployment
mid-provisioning, advances the clock past the deadline, runs the sweeper, and
asserts it is still `terminated` — the case that breaks `setTimeout`-based
implementations.

---

## 3. Scaling the metering pipeline to 10,000 requests/second

**What breaks first.** Each completion makes two synchronous round trips: the
rate-limiter counter and the usage-event insert. At 10k rps that is 20k
ops/second against one primary, and the insert sits on the response path — so
p99 latency is bounded by MongoDB write latency, and a replication hiccup
becomes a user-visible outage. The `{ request_id: 1 }` unique index also makes
every insert pay for a second index maintenance write.

**Take the write off the request path.** Two stages, in order of how far you
need to go:

1. *In-process batching.* Push events into a bounded ring buffer and flush with
   `insertMany` every ~1,000 events or ~50 ms. One round trip amortized across a
   thousand requests. Cheap, and enough for low thousands of rps.
2. *Durable log.* Append to Kafka or Kinesis partitioned by `api_key_id`, and
   let a consumer group do the database writes. The API process now does one
   sequential append instead of a random-access insert, and metering throughput
   scales by adding consumers rather than by resizing the primary. Partitioning
   by `api_key_id` keeps per-key ordering, which matters if you later add
   balance checks or quota enforcement that must see events in order.

**Accept at-least-once and dedupe on `request_id`.** This is what makes an
async pipeline acceptable for billing at all: a replayed event is idempotent
because the unique index rejects it. The idempotency guarantee is not a
nice-to-have bolted on afterwards — it is the precondition for moving the write
off the request path.

**Stop scanning raw events.** `/usage` currently aggregates the ledger, whose
cost grows with request volume. Consumers should maintain rollups incremented
with `$inc`, keyed by `(tenant_id, api_key_id, model, bucket)`:
`usage_minute → usage_hour → usage_day`. `/usage` then reads a bounded number of
pre-aggregated documents and its latency stops depending on traffic. Raw events
move to cheap object storage after a retention window and stay available for
dispute resolution.

**Shard on `tenant_id`.** Usage queries are always tenant-scoped, so this is a
targeted single-shard query rather than a scatter-gather. Hashed sharding on
`tenant_id` also spreads the write load evenly, whereas sharding on
`occurred_at` would make the newest chunk a hotspot for every write.

**Move the limiter out of the database.** One Redis `INCR` plus `EXPIRE` per
request, or a token bucket in the same place. At 10k rps this also wants to
become a sliding window or token bucket, because a fixed window's boundary
burst is 20k requests in two seconds.

**The failure modes this buys, and what to do about them.** Being explicit about
these is the point — each fix trades one problem for another:

- *Buffered events can be lost* if a process dies before flushing. The exposure
  is bounded by the flush interval (~50 ms of traffic). If losing even that is
  unacceptable, the durable log is the answer, because the append is what
  becomes the commit point.
- *Rollups can drift* from the ledger through a consumer bug or a partial
  replay. Mitigation: a nightly reconciliation job recomputes each day from raw
  events, compares against the rollup, and alerts on mismatch — the raw ledger
  stays the source of truth, and the rollups are a cache.
- *`/usage` becomes seconds-stale* behind consumer lag. Acceptable for
  invoicing; not acceptable for a live "current spend" dashboard or a hard quota
  cutoff, so those need either the buffer flushed synchronously for the
  quota-critical path or an explicit "as of" timestamp in the response.
- *Hot keys.* One abusive `api_key_id` concentrates on a single Kafka partition
  and a single rollup document. Sharding the counter (`key:bucket:0..N` summed
  on read) fixes the document contention.

---

## 4. What I would do differently with more time

- **Sliding-window or token-bucket rate limiting** in Redis, removing both the
  boundary burst and the per-request database write.
- **Hash-only API key storage** with a one-time reveal at creation, instead of
  keeping plaintext to satisfy the spec's repeated `GET` (see Assumption 1).
- **Real tenant authentication** — `X-Account-Key` required, every query scoped
  by `tenant_id`, and key rotation and revocation endpoints.
- **Rollup collections plus the reconciliation job** from section 3, which is
  the single biggest structural change and the one I would do first.
- **A generated OpenAPI document** from the Zod schemas, so the contract is
  machine-checkable rather than described in this file.
- **A load test** to find the actual ceiling instead of reasoning about it. I
  can argue where this breaks; I have not measured it, and the difference
  matters.
- **Structured audit logging** of every 401/403/409 with the key prefix, which
  is what you actually need when a customer says "my key stopped working".
- **A `/usage` variant scoped by tenant** using a header rather than a
  query-string credential (see Assumption 5).

---

## 5. Trade-offs

**Synchronous metering, at the cost of latency.** The usage event is written
before the response is sent, and only on success. A failed insert returns 500,
so the caller gets neither output nor a charge. Fire-and-forget would be faster
but can silently drop events, which breaks the one property this service exists
to provide. Section 3 describes how to remove the latency cost without
reintroducing loss; that machinery is not built here because it is not warranted
at this scale.

**Fixed window rather than sliding.** One write, trivially correct within a
window, and it satisfies the spec's literal "max 100 requests per minute". The
cost is a boundary burst: 100 requests at 11:59:59 plus 100 at 12:00:00. This is
documented rather than hidden; a sliding-window counter is about 25 more lines
and two reads, and a token bucket is what a real gateway uses.

**Rate limiter in MongoDB rather than an in-process `Map`.** The Map is faster
and needs no round trip, but it makes the limit per-instance rather than per-key
— which would contradict the multi-instance guarantee the state machine
provides. Being inconsistent about that seemed worse than paying for one upsert.
Both implementations exist behind a `RateLimiter` interface and are selected by
`RATE_LIMIT_STORE`.

**Plaintext `secret` in `api_keys`.** A real breach of correct practice, made
deliberately: the spec requires `GET /deployments/:id` to return `api_key` on
every call, which is incompatible with storing only a hash. The schema keeps
`key_hash` as the authentication path, so deleting the `secret` field would
leave the system functional.

**403 instead of 404 for an unknown deployment on the completions path.** An
API key is bound to exactly one deployment, so comparing `key.deployment_id` to
the path parameter is sufficient — and returning 404 there would confirm to a
key holder which deployment ids exist. This saves a query and closes an
enumeration channel. `GET /deployments/:id` still returns 404, because there is
no key-bound caller to protect. Reasonable people would return 404; I would
rather explain this choice than leak the ids.

**Authorization checked before resource state.** A caller with the wrong key
gets 403, never 409, so they cannot learn that a deployment exists or what state
it is in. The rate limit sits between authentication and authorization, because
a limit belongs to an identity rather than to a resource.

**MongoDB single-document atomicity instead of relational constraints.** Every
mutation here is a single-document conditional update, which makes the state
machine lock-free and race-free without transactions — and means a standalone
`mongod` suffices. What is given up is foreign keys and `CHECK` constraints;
`$jsonSchema` validators recover the enum and integer guarantees, and
referential integrity is enforced in the repository layer. The immutable
denormalized ledger means less of it is needed in the first place.

**Read-time promotion *and* a background sweeper.** Either alone would work.
Read-time promotion keeps observable state correct if the sweeper is down; the
sweeper keeps stored state from going stale when nobody is looking. Both share
one conditional update, so the redundancy costs almost nothing.

**In-process MongoDB by default.** Optimized for the reviewer being able to run
this in one command, at the cost of a one-time binary download and a dev
dependency doing something at runtime. `MONGODB_URI` and `docker compose` are
both first-class alternatives.

---

## Assumptions

Where the spec was silent or self-conflicting, these are the calls I made.

1. **`api_keys.secret` is stored in plaintext**, because the spec requires
   `GET /deployments/:id` to return `api_key` on every call. Production systems
   reveal a key exactly once and store only its hash. `key_hash` remains the
   authentication path, so dropping `secret` would leave the system working.
2. **An unknown `deployment_id` on the completions endpoint returns 403, not
   404** — see Trade-offs.
3. **Fixed-window rate limiting** permits up to 2× the limit across a window
   boundary.
4. **`day` grouping is UTC only.** The spec has no notion of a per-tenant
   billing timezone.
5. **`GET /usage` takes the API key as a query parameter**, per the spec. This
   places a credential in URLs, proxy logs, and browser history, and lets any
   key holder read that key's usage. A tenant-scoped variant using
   `X-Account-Key` and an `Authorization` header is the correct design.
6. **Metering is synchronous**, trading per-request latency for zero event loss.
7. **`X-Account-Key` is optional**, defaulting to a seeded demo tenant, so the
   walkthrough commands need no setup.
8. **Provisioning duration is configurable** (`PROVISIONING_MS`, default
   `10000`) so tests and demos can shorten it; the default matches the spec's
   ~10 seconds.
9. **`output_tokens` uses an injectable RNG**, seeded in tests and random in
   production.
10. **`input_tokens` is floored at 1 for a non-empty prompt.** The spec's
    `round(len / 4)` yields `0` for a one-character prompt, which would make a
    billable request free on the input side. Empty prompts are rejected by
    validation before this point.
11. **`endpoint_url` is `{PUBLIC_BASE_URL}/v1/{deployment_id}`**, so the URL
    handed out is directly callable.
12. **The zero-setup path downloads a `mongod` binary once** (~100 MB, cached).
    `MONGODB_URI` and `docker compose` skip it.
13. **A standalone `mongod` is sufficient — no replica set.** No code path opens
    a transaction; that is a design property, not a limitation worked around.
14. **The default `/usage` window is day-aligned** — midnight 30 days back to
    the midnight after today — rather than ending at `now`. With a half-open
    range, ending at `now` drops an event recorded at that same instant, and
    day alignment yields whole `day` buckets with no partial bucket at either
    edge. An explicit `from`/`to` is used verbatim. (A test asserting that
    just-recorded usage appears in the default report is what caught this.)
15. **`POST /deployments` returns 201**, and `DELETE` is idempotent — repeat
    calls return the same terminated representation rather than 404 or 409.

---

## Project layout

```
src/
  config/env.ts               Zod-validated environment, fails fast on boot
  clock.ts  random.ts         Injectable Clock and Rng — no test waits on time
  crypto.ts  ids.ts           sha256, prefixed ids, key generation

  domain/                     PURE. No I/O. Where the tests bite.
    deployment.ts             deriveStatus(), isDueForPromotion(), assertServable()
    pricing.ts                integer micro-USD arithmetic and formatting
    tokens.ts                 countInputTokens(), sampleOutputTokens()
    errors.ts                 AppError taxonomy → HTTP status mapping

  db/                         client (with in-process fallback), typed
                              collections, idempotent bootstrap
  repositories/               queries only, no business rules
  services/                   orchestration: deployments, completions, usage
  ratelimit/                  RateLimiter interface + Mongo and memory backends
  workers/                    provisioning sweeper
  http/                       server, routes, Zod schemas, error handler
  index.ts                    env → db → bootstrap → server → sweeper

tests/
  unit/                       domain, config, error taxonomy, server skeleton
  integration/                bootstrap, deployments, completions, ratelimit, usage
  helpers/                    ephemeral mongod, test app with FakeClock
```

`buildServer()` is separate from `listen()`, so tests exercise real HTTP through
`fastify.inject()` without binding a port. `domain/` imports nothing that
performs I/O, which is why the state machine and the pricing arithmetic test in
milliseconds.

### What the tests cover, and why those things

The spec asks for at least two meaningful tests and says the choice matters more
than coverage. 71 tests across 11 files, all targeting invariants whose failure
would produce wrong money or wrong state. **No test sleeps** — a `FakeClock` is
injected, so the ten-second provisioning path is exercised instantly.

| Suite | The invariant |
| --- | --- |
| `unit/deployment` | Terminated is absorbing; the deadline boundary is exact to the millisecond |
| `unit/pricing` | The published rates are integer-exact; 10,000 summed costs do not drift |
| `unit/tokens` | Token estimate rounds, and never bills zero |
| `integration/deployments` | Terminate mid-provisioning survives the sweeper and a read |
| `integration/completions` | **No rejected request ever writes a billing record** — asserted for all seven rejection cases |
| `integration/completions` | N requests produce exactly N events whose token sums match the responses |
| `integration/completions` | An `Idempotency-Key` retry replays the stored event and does not double-charge |
| `integration/ratelimit` | Boundary is exact, windows refill, keys are isolated — for both backends |
| `integration/usage` | Day buckets are UTC, the range excludes `to`, and `/usage` reconciles with real requests |
| `integration/bootstrap` | Validators refuse a bad enum and a non-integer token count |

---

## 6. AI assistance

I used Claude (Claude Code) throughout, and I understand every line here.
Specifically:

- **Design conversation.** I worked through the ambiguities in the spec with it
  before writing code — the provisioning mechanism, whether to hash the API key,
  where the rate limit sits in the check order, 403-versus-404. The design
  document in `docs/` is the record of that, including the alternatives I
  rejected. The decisions are mine; the dialogue sharpened them.
- **Code generation.** Most of the implementation and test code was drafted with
  AI and then reviewed and corrected by me. Three things I changed on review:
  the error handler's type narrowing under Fastify 5, the test helper resetting
  collections instead of booting a `mongod` per test (43s → 9s on the
  completions file), and the default `/usage` window, which was ending at `now`
  and silently excluding the newest event.
- **README.** Drafted with AI from the design document, then edited — the
  scaling section in particular, where I wanted the failure modes stated rather
  than just the fixes.
- **Not AI.** The verification. Every status code and JSON body in the
  walkthrough above was copied from an actual run against the built service, not
  from what the model predicted the output would be. The one dependency change
  (upgrading Vitest to clear five advisories) came from running `npm audit`.

Rough time spent: about 5 hours, of which roughly a third went to the design
document and this README.
