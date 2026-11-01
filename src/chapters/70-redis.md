---
title: Caching and limits
day: 83
time: "3 hours"
description: Cache a hot read in Redis, invalidate it when an event arrives, and use the same store for a rate limit.
sidebar:
  order: 70
---

The activity feed is a read-heavy endpoint. The same fifty rows are requested
again and again, and the in-memory list is cheap only while the process
holds it. Add a second instance and each one builds its own list; restart and
the list is gone.

**Redis** is an in-memory data store with a network interface. It is good at
caching, short-lived state, and counters. A cache is a copy of a read that is
allowed to be stale for a bounded time; the **TTL** is that bound.

Today we put Redis in front of the feed, invalidate it when an event arrives,
and use the same connection for a rate-limit counter.

## Cache aside

The read path checks Redis first. A hit returns the cached body; a miss builds
the response, stores it for five seconds, and returns it:

<!-- verify: cmd/todo-activity/main.go at=redis -->
```go title="cmd/todo-activity/main.go"
const activityCacheKey = "activity:latest"

func cachedActivity(ctx context.Context, rdb *redis.Client, store *activity.Store) ([]byte, error) {
	if rdb == nil {
		return json.Marshal(store.List(50))
	}
	if body, err := rdb.Get(ctx, activityCacheKey).Bytes(); err == nil {
		return body, nil
	}
	body, err := json.Marshal(store.List(50))
	if err != nil {
		return nil, err
	}
	rdb.Set(ctx, activityCacheKey, body, 5*time.Second)
	return body, nil
}
```

The `rdb == nil` branch is the no-Redis path; the service still works without
the cache. That is a useful property for local development and for a degraded
mode: a cache is an optimization, not a dependency the read cannot survive.

`Get` returns `redis.Nil` on a miss. The code treats every error as a miss and
rebuilds; a Redis outage makes the endpoint slower, not broken. The `Set` is
fire-and-forget; a failed write just means the next read rebuilds.

## Invalidate on write

A cache is only as good as its invalidation. The service deletes the key when
an event is added, whether the event came from HTTP or Kafka:

<!-- verify: cmd/todo-activity/main.go at=redis -->
```go title="cmd/todo-activity/main.go"
func invalidateCache(ctx context.Context, rdb *redis.Client) {
	if rdb == nil {
		return
	}
	rdb.Del(ctx, activityCacheKey)
}
```

Delete on write is the simplest invalidation. It trades a cache miss for
correctness: the next read rebuilds. A write-through cache updates the value
instead, but then two writers can race and the last update wins in the cache
while the store has a different order. Deleting is harder to get wrong.

The TTL is the backstop. If an invalidation is lost — a crash between the
store write and the delete — the stale value expires in five seconds. The
window is the price of the cache; the TTL bounds it.

## Run it

Start Redis and the service:

```bash
$ podman run -d --name todo-redis -p 16379:6379 redis:7-alpine
...
$ go run ./cmd/todo-activity -listen 127.0.0.1:18090 -grpc 127.0.0.1:19093 -redis 127.0.0.1:16379
2026/10/31 15:18:10 INFO activity gRPC listening addr=127.0.0.1:19093
2026/10/31 15:18:10 INFO activity listening addr=127.0.0.1:18090
```

Post one event and read the feed twice:

```bash
$ curl -sS -X POST http://127.0.0.1:18090/activity -H 'Content-Type: application/json' -d '{"id":"evt-redis-1","task_id":"t-r1","kind":"created","title":"cache the feed"}'
...
$ curl -sS http://127.0.0.1:18090/activity
[{"id":"evt-redis-1","task_id":"t-r1","kind":"created","title":"cache the feed","at":"2026-10-31T09:48:10.93603558Z"}]
$ curl -sS http://127.0.0.1:18090/activity
[{"id":"evt-redis-1","task_id":"t-r1","kind":"created","title":"cache the feed","at":"2026-10-31T09:48:10.93603558Z"}]
```

Inspect the key:

```bash
$ podman exec todo-redis redis-cli GET activity:latest
[{"id":"evt-redis-1","task_id":"t-r1","kind":"created","title":"cache the feed","at":"2026-10-31T09:48:10.93603558Z"}]
$ podman exec todo-redis redis-cli TTL activity:latest
5
```

The TTL is five seconds; the exact value counts down. The second HTTP request
was served from the cached body, not from the in-memory list.

## Rate limiting

The same Redis connection can count requests. A fixed window is one `INCR`
plus an `EXPIRE`:

```text
key = "rate:" + client + ":" + minute
n = INCR key
if n == 1: EXPIRE key 60
if n > limit: reject 429
```

`INCR` is atomic, so two instances see one counter. The window is coarse — a
burst at the boundary can pass twice — and a token bucket or a sliding log is
smoother. For a login limiter, the book already uses an in-process token
bucket; the Redis version is the one that works across instances.

A rate limit is not a cache. It must fail closed when Redis is down, because
the alternative is unbounded traffic. That is a different policy from the
feed, where a Redis outage should degrade to the slower path. Decide per use
case; do not reuse the cache's failure mode for the limiter.

## Eviction and memory

Redis is memory. A cache with no eviction policy eventually refuses writes or
the operating system kills it. The policy decides which key to drop when the
limit is reached: `allkeys-lru` for a pure cache, `volatile-lru` for keys with
a TTL, `noeviction` for a store that must not lose data.

The feed cache is a pure cache: losing it costs a rebuild, not a row. The
rate-limit counters are not: losing them resets a window and lets a burst
through. They should live in a different Redis database or instance, or the
policy should be chosen for the stricter use.

The memory limit is a budget, not a suggestion. A cache that can grow to the
host's RAM will compete with the database and the service. Set `maxmemory`,
choose the policy, and watch the eviction count; a cache that evicts constantly
is too small or the TTL is too long.

## Serialization is a contract

The cached body is the HTTP response, not a Go struct. That is deliberate: a
hit can be written without decoding and re-encoding, and the cache does not
need to know the feed's type. The cost is that a change to the response shape
is a cache invalidation, not a code change the compiler checks.

The key carries the shape version when that matters: `activity:v1:latest`
rather than `activity:latest`. A deploy that changes the JSON bumps the prefix,
and the old entries expire on their own. The TTL is the fallback; the version
is the explicit invalidation.

## If something went wrong

- **`WRONGTYPE`** — another key with the same name holds a different type.
  Namespace keys (`activity:latest`, `rate:...`) and keep them unique.
- **The feed never updates** — the invalidation is missing or the key is
  written by a different service. Check `redis-cli TTL`; a missing key means
  the next read rebuilds.
- **`connection refused`** — Redis is not running or the address is wrong.
  The service exits at boot if `-redis` is set and the ping fails; that is
  intentional, so a misconfiguration is loud.
- **The cache is always cold** — the TTL is shorter than the request rate, or
  every write invalidates. Measure the hit rate before lowering the TTL.

<details>
<summary>Going deeper: cache stamps and thundering herds</summary>

When a hot key expires, many requests miss at once and all rebuild the same
value. That is a **thundering herd**. A common fix is a short lock: the first
miss takes a `SET NX` lock, rebuilds, and the others wait or serve stale.

Another fix is a **stale-while-revalidate** policy: serve the old value for a
short window while one caller refreshes it. The cache stores two timestamps,
fresh-until and stale-until, and the read path decides. The book's five-second
TTL is small enough that the herd is short; a production feed with a larger
value would want one of these.

</details>

The feed is cheaper to read now, and the cache has a clear invalidation rule.
Next we push the change to the browser as it happens.
