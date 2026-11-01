# Chapter 73 — observability at scale

```text
$ curl -sS http://127.0.0.1:18092/metrics | grep '^activity_events_total'
activity_events_total{kind="completed"} 1
activity_events_total{kind="created"} 1

$ curl -sS 'http://127.0.0.1:19090/api/v1/targets' | jq -c '.data.activeTargets[] | {scrapeUrl,health,lastError,lastScrape}'
{"scrapeUrl":"http://127.0.0.1:18092/metrics","health":"up","lastError":"","lastScrape":"2026-10-31T09:51:24.942785052Z"}

$ curl -sS 'http://127.0.0.1:19090/api/v1/query?query=activity_events_total' | jq -c '.data.result[] | {kind:.metric.kind,value:.value[1]}'
{"kind":"completed","value":"1"}
{"kind":"created","value":"1"}
```
