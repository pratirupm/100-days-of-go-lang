---
title: "Day 68 — Storage that outlives the machine"
description: "Write database backups to S3 with a role, then restore one and compare it with the original. — Day 68 of 100 Days of Go Lang."
sidebar:
  order: 68
chapter: 57
style: production
---

**About 3 hours** · Part XII, day 2 of 5.

**You'll be able to:**

- write backups to S3 with a role, not a password;
- restore one and compare it with the original.

---

A task's disk disappears with the task. That is fine for a stateless server
and fatal for a database. The data needs a place that survives the process,
the machine, and the deployment.

**S3** is object storage: a bucket holds objects, and each object has a key.
There is no filesystem and no partial write; an upload either creates the
object or fails. That shape fits backups well. A **bucket** is the namespace;
a **key** is the path inside it.

Today we write a backup to S3, list it, download it, and compare it with the
original byte for byte.

## The script

The backup script is deliberately small. It names the bucket, stamps the
key, and copies the database:

<!-- verify: deploy/aws/backup-to-s3.sh at=aws-storage -->
```sh title="deploy/aws/backup-to-s3.sh"
#!/bin/sh
# deploy/aws/backup-to-s3.sh — copy the database to S3 with a timestamped key.
#
# The script is deliberately dumb: one object per run, no retention policy.
# A bucket lifecycle rule is the right place for retention, not a shell loop.
set -eu

: "${TODO_BACKUP_BUCKET:?set TODO_BACKUP_BUCKET}"
: "${TODO_DB:=/data/todo.db}"

stamp=$(date -u +%Y%m%dT%H%M%SZ)
key="todo-${stamp}.db"

aws s3 cp "$TODO_DB" "s3://${TODO_BACKUP_BUCKET}/${key}" --only-show-errors
echo "s3://${TODO_BACKUP_BUCKET}/${key}"
```

`set -eu` stops on the first error and on an unset variable. The `:?` form is
a guard: if `TODO_BACKUP_BUCKET` is missing, the script exits with the message
instead of writing to an empty path. The timestamp is UTC so the key sorts
and reads the same on every machine.

`aws s3 cp` copies one file. `--only-show-errors` keeps the progress output
out of a log that only needs the final key. The script prints the object's
URL; a scheduler can capture that line as the backup's identity.

The bucket itself is separate state. Create it once:

```bash
$ aws s3 mb s3://todo-backups
make_bucket: todo-backups
```

For the local endpoint the command is the same; the endpoint flag or
`AWS_ENDPOINT_URL` points at the emulator. In a real account, the bucket has
versioning and a lifecycle rule that expires old objects. The script does
not delete anything; retention is the bucket's job.

## Run it

Point the script at the database and the bucket:

```bash
$ TODO_BACKUP_BUCKET=todo-backups TODO_DB=/tmp/todo.db ./deploy/aws/backup-to-s3.sh
s3://todo-backups/todo-20261031T092318Z.db
```

List the result:

```bash
$ aws s3 ls s3://todo-backups/ | tail -1
2026-10-31 14:53:19       8192 todo-20261031T092318Z.db
```

The size is 8,192 bytes, the same as the database file. The key carries the
timestamp, so two runs never overwrite each other. If the bucket has
versioning, even a reused key would keep its history; the timestamp makes
the common case obvious.

## Restore it

A backup is not a backup until it has been restored. Download the object to a
scratch path:

```bash
$ aws s3 cp s3://todo-backups/todo-20261031T092318Z.db /tmp/restored.db --only-show-errors
...
```

Compare the bytes:

```bash
$ cmp /tmp/todo.db /tmp/restored.db && echo identical
identical
```

`cmp` is intentionally strict. It proves the object is not truncated and not
silently changed by the transfer. It does not prove the database opens; a
restore drill that opens it is the next step. For this small exercise the file
is a complete SQLite database, so a byte-for-byte comparison is meaningful.

Ask S3 for the object's size and checksum:

```bash
$ aws s3api head-object --bucket todo-backups --key todo-20261031T092318Z.db --query '{ContentLength:ContentLength,ETag:ETag}'
{
    "ContentLength": 8192,
    "ETag": "\"84e1057022a41175cf1d21f4ce8409dc\""
}
```

The ETag is S3's identity for the object. For a single-part upload it is the
MD5 of the content; for a multipart upload it is a different value. Do not
build a restore check on the ETag alone; compare the restored file or open
it with the application.

## Who is allowed to write

The script has no credentials in it. It relies on the environment: a role on
the machine or task, an AWS profile on a laptop, or the local emulator's test
keys. A key pasted into a script is a key that will end up in a shell history
and a backup.

The role needs `s3:PutObject` on the bucket and `s3:GetObject` for restores.
It does not need `s3:DeleteObject`; retention belongs to the lifecycle rule.
The next lesson builds that role and the secret store the task reads.

## Versioning and lifecycle

The timestamped key gives the bucket a history, but the bucket's own settings
decide how long that history survives. **Versioning** keeps every overwrite of
the same key; it is the safety net for a bad upload. A **lifecycle rule** moves
old versions to cheaper storage or expires them.

The two settings answer different questions. Versioning answers "can I get the
previous object back?" A lifecycle rule answers "how much history am I willing
to pay for?" A bucket with versioning and no lifecycle grows forever; a bucket
with a lifecycle and no versioning can lose the only copy when an upload
overwrites it.

For backups, the key already carries the timestamp, so versioning is a second
layer rather than the primary one. The lifecycle rule can expire objects after
the recovery window — thirty days, ninety days, a year — and the restore drill
proves the remaining object still opens. A backup policy without a restore
drill is a hope, not a control.

## Encryption

S3 encrypts objects at rest by default with an AWS-managed key. That protects
the disk, not the bucket: anyone with `s3:GetObject` can read the object. A
customer-managed KMS key adds an access policy and an audit trail, and it lets
you revoke access by disabling the key.

The bucket policy and the IAM policy are two doors. The bucket policy can deny
an action even when the IAM policy allows it, and the reverse is also true.
The safe shape is a bucket policy that requires TLS and denies public access,
plus an IAM role that grants only the actions the task needs. The backup script
does not encrypt the file itself; the bucket's default encryption does.

## If something went wrong

- **`Unable to locate credentials`** — no profile, role, or environment. Set
  `AWS_PROFILE`, or run on a machine with an instance/task role.
- **`AccessDenied` on `PutObject`** — the role can list the bucket but not
  write it. Check the policy's resource ARN; `arn:aws:s3:::todo-backups/*`
  covers objects, while the bucket ARN covers the bucket itself.
- **`NoSuchBucket`** — the bucket name is wrong or the bucket is in another
  region. S3 bucket names are global.
- **`cmp` reports a difference** — the upload or download was truncated, or
  the database was being written while it was copied. Stop the writer or use
  a snapshot-consistent copy before uploading.

<details>
<summary>Going deeper: why the timestamp is not enough</summary>

A timestamped key gives you history, but it does not give you a retention
policy. Without a lifecycle rule the bucket grows forever; with a rule that
expires too aggressively, the backup you need may already be gone. A real
policy names a recovery point objective: how much data may be lost, and how
far back a restore must reach.

The same rule applies to the database copy. Copying a live file can capture a
torn write. The production shape is a snapshot or a database-native dump,
then an upload of that stable artifact. The script is the transport, not the
consistency mechanism.

</details>

The data has a home outside the task now. Next we give the task a narrow
identity and move its bootstrap key into a managed secret store.

<div class="day-tracker" data-day="68"></div>
