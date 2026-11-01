# Chapter 63 — migrations and transactions

```text
$ podman exec todo-postgres psql -U todo -d todo_migrate -c "SELECT version_id, is_applied FROM goose_db_version ORDER BY id;"
 version_id | is_applied
------------+------------
          0 | t
          1 | t
          2 | t
(3 rows)

$ podman exec todo-postgres psql -U todo -d todo_migrate -c "BEGIN; INSERT INTO tasks (id,title,status,priority,version) VALUES ('00000000-0000-7000-8002-000000000001','rollback me','Todo',3,1); SELECT count(*) FROM tasks; ROLLBACK; SELECT count(*) FROM tasks;"
BEGIN
INSERT 0 1
 count
-------
     1
(1 row)

ROLLBACK
 count
-------
     0
(1 row)
```
