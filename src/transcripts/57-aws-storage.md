# Chapter 57 — storage that outlives the machine

```text
$ aws s3 mb s3://todo-backups
make_bucket: todo-backups

$ TODO_BACKUP_BUCKET=todo-backups TODO_DB=/tmp/todo.db ./deploy/aws/backup-to-s3.sh
s3://todo-backups/todo-20261031T092318Z.db

$ aws s3 ls s3://todo-backups/ | tail -1
2026-10-31 14:53:19       8192 todo-20261031T092318Z.db

$ aws s3 cp s3://todo-backups/todo-20261031T092318Z.db /tmp/restored.db --only-show-errors
...
$ cmp /tmp/todo.db /tmp/restored.db && echo identical
identical

$ aws s3api head-object --bucket todo-backups --key todo-20261031T092318Z.db --query '{ContentLength:ContentLength,ETag:ETag}'
{
    "ContentLength": 8192,
    "ETag": "\"84e1057022a41175cf1d21f4ce8409dc\""
}
```
