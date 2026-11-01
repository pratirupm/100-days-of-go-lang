---
title: "Day 85 — Review: Part XIV"
description: "Review day 85 of 100 Days of Go Lang: the production drills for Part XIV."
sidebar:
  order: 85
style: production
---

**About 1.5 hours** · Part XIV, review.

- Start the service, the worker, Kafka, and Redis; publish one event.
- Watch the consumer index the event; reset the group and replay it.
- Call the gRPC endpoint through the API and check the deadline path.
- Open the WebSocket, change a task, and see the push arrive.

A service boundary is real when the pieces can be started, stopped, and replayed independently. That is the test this review runs.

<div class="day-tracker" data-day="85"></div>
