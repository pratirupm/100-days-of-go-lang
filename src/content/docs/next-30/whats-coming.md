---
title: The next 30 days
description: "The 30 days after the course: Kubernetes, Docker, AWS, CI/CD, PostgreSQL, Kafka, Redis, gRPC, WebSockets, and the rest of production ground — the working list."
sidebar:
  label: What's coming
  order: 1
---

The first sixty days build the whole application — and stop at the door of
production. The next thirty walk through it: the ground a working engineer
stands on.

This is the working list. Lessons land here as they're written, and where the
first sixty already covered a topic, it gets folded in or skipped rather than
repeated.

## New ground

- **Kubernetes** — running the app as containers on a cluster: deployments,
  services, config, and rollouts that don't drop requests.
- **Docker** — containers for the app and its database, built and run by hand
  before anything orchestrates them.
- **AWS** — the same app on real cloud infrastructure: compute, storage, and
  the managed services actually worth using.
- **CI/CD** — pipelines that build, test, and ship on every change, running
  the same checks the book runs locally.
- **Microservices** — splitting one service along its seams, and paying the
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

Every day here will work the way the first sixty do: a real piece of the
system, built test-first, with the commands and outputs shown as they really
ran — and the same honesty about what was measured versus assumed.
