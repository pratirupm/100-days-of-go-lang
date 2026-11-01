# Chapter 62 — queries and indexes

```text
$ podman exec todo-postgres psql -U todo -d todo -c "INSERT INTO tasks (id,title,status,priority,version) SELECT '00000000-0000-7000-8000-'||lpad(i::text,12,'0'), 'task '||i, 'Todo', 3, 1 FROM generate_series(1,10000) i; INSERT INTO tasks (id,title,status,priority,version) SELECT '00000000-0000-7000-8001-'||lpad(i::text,12,'0'), 'done '||i, 'Done', 3, 1 FROM generate_series(1,1000) i; ANALYZE tasks;"
INSERT 0 10000
INSERT 0 1000
ANALYZE

$ podman exec todo-postgres psql -U todo -d todo -c "EXPLAIN (ANALYZE, BUFFERS) SELECT id, title, status, priority, due, version FROM tasks WHERE status = 'Done' AND owner_id IS NOT DISTINCT FROM NULL ORDER BY id;"
...
$ podman exec todo-postgres psql -U todo -d todo -c "DROP INDEX IF EXISTS tasks_status_owner; ANALYZE tasks; EXPLAIN (ANALYZE, BUFFERS) SELECT id, title, status, priority, due, version FROM tasks WHERE status = 'Done' AND owner_id IS NOT DISTINCT FROM NULL ORDER BY id;"
DROP INDEX
ANALYZE
                                                  QUERY PLAN
--------------------------------------------------------------------------------------------------------------
 Sort  (cost=312.33..314.83 rows=1000 width=91) (actual time=1.280..1.314 rows=1000 loops=1)
   Sort Key: id
   Sort Method: quicksort  Memory: 103kB
   Buffers: shared hit=125
   ->  Seq Scan on tasks  (cost=0.00..262.50 rows=1000 width=91) (actual time=0.842..0.972 rows=1000 loops=1)
         Filter: ((owner_id IS NULL) AND (status = 'Done'::text))
         Rows Removed by Filter: 10000
         Buffers: shared hit=125
 Planning:
   Buffers: shared hit=33
 Planning Time: 0.184 ms
 Execution Time: 1.391 ms

$ podman exec todo-postgres psql -U todo -d todo -c "CREATE INDEX tasks_status_owner ON tasks(status, owner_id); ANALYZE tasks; EXPLAIN (ANALYZE, BUFFERS) SELECT id, title, status, priority, due, version FROM tasks WHERE status = 'Done' AND owner_id IS NOT DISTINCT FROM NULL ORDER BY id;"
ANALYZE
                                                               QUERY PLAN
----------------------------------------------------------------------------------------------------------------------------------------
 Sort  (cost=205.86..208.36 rows=1000 width=91) (actual time=0.390..0.419 rows=1000 loops=1)
   Sort Key: id
   Sort Method: quicksort  Memory: 103kB
   Buffers: shared hit=12 read=2
   ->  Bitmap Heap Scan on tasks  (cost=18.54..156.03 rows=1000 width=91) (actual time=0.038..0.128 rows=1000 loops=1)
         Recheck Cond: ((status = 'Done'::text) AND (owner_id IS NULL))
         Heap Blocks: exact=12
         Buffers: shared hit=12 read=2
         ->  Bitmap Index Scan on tasks_status_owner  (cost=0.00..18.29 rows=1000 width=0) (actual time=0.031..0.031 rows=1000 loops=1)
               Index Cond: ((status = 'Done'::text) AND (owner_id IS NULL))
               Buffers: shared read=2
 Planning:
         Buffers: shared hit=33 read=1
 Planning Time: 0.182 ms
 Execution Time: 0.494 ms
```
