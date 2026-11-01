---
title: Production ground — days 61–90
description: "The thirty days after the first sixty: containers, a cloud, a production database, services, streams, and the reliability work that holds them together."
sidebar:
  label: Production ground
  order: 1
---

The first sixty days build the whole application — and stop at the door of
production. The next thirty walk through it: the ground a working engineer
stands on. All thirty days are written. Start at
[Day 61 — The app in a box](/100-days-of-go-lang/days/day-61/) and follow
[The days](/100-days-of-go-lang/days/) through Day 90. This page keeps the
shape of the stretch.

## The shape

| Days | Part | What it adds |
| --- | --- | --- |
| 61–66 | Containers and clusters | The image, Compose, Kubernetes deployments, probes, and rollouts |
| 67–72 | Cloud and delivery | AWS compute, S3, IAM and secrets, checks, and a deploy |
| 73–78 | Data at scale | PostgreSQL, queries and indexes, migrations, load tests, tuning |
| 79–85 | Services and streams | A service boundary, gRPC, Kafka, Redis, and WebSockets |
| 86–90 | Reliability | Retries and ordering, observability, testing, security, and a failure drill |

:::caution
The AWS days are validated against a local AWS-compatible endpoint. The
templates and commands are the real ones; point the CLI at your account, and
remove the local endpoint, to deploy for real.
:::

## New ground

- **Kubernetes** — running the app as containers on a cluster: deployments,
  services, config, and rollouts that don't drop requests.
- **Docker** — containers for the app and its proxy, built and run by hand
  before anything orchestrates them.
- **AWS** — the same app on real cloud infrastructure: compute, storage, and
  the managed services actually worth using.
- **CI/CD** — checks that build, test, and ship on every change, running the
  same commands the book runs locally.
- **Microservices** — splitting one read model along its seam, and paying the
  bill honestly.
- **Distributed systems** — retries, idempotency, ordering, and what
  "exactly once" really means.
- **PostgreSQL** — the production database: migrations, queries, and indexes
  at scale. The store interface was built so this swap stays real.
- **Kafka** — event streams: producers, consumers, and replay.
- **Redis** — caching, ephemeral state, and rate limiting.
- **gRPC** — typed service-to-service calls, beside the REST API.
- **WebSockets** — live updates pushed to clients.

## Already met — deepened here

- **Observability and monitoring** — dashboards, alerting, and logs at
  scale, on top of the traces, metrics, and profiles the app already emits.
- **Performance tuning** — load testing and profiling under production
  traffic, past the measurement loop the last days taught.
- **Testing** — contract tests, load tests, and the habits that survive a
  distributed system.
- **Security** — threat modeling at scale, supply chain, and rotation, past
  the web hardening and the audit.

## Shaped like the first sixty

Every day here works the way the first sixty do: a real piece of the system,
a claim that can fail, and the command or test that decides it — with the
commands and outputs shown as they really ran, and the same honesty about
what was measured versus assumed.

The data-structures stretch follows in
[The 10 days of DSA](/100-days-of-go-lang/dsa-10/whats-coming/).
