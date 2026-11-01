---
title: Keys and permissions
day: 69
time: "3 hours"
description: Give the task a narrow IAM role, move the bootstrap key into Systems Manager, and prove the secret can be read without a rebuild.
sidebar:
  order: 58
---

The backup script assumed it could write to S3. The task definition assumed
it could read a parameter. Neither said who was allowed to do those things.
In AWS, that answer is an **IAM role**: a set of permissions attached to a
principal, with a trust policy that says who may assume it.

A **policy** names actions and resources. A **trust policy** names the
service that may use the role. A **parameter** in Systems Manager is a
versioned key-value store; `SecureString` encrypts the value with KMS.

Today we create the role, attach the narrow policy, store the admin key, and
read it back. The secret never enters the image or the template.

## The permissions

The policy is two statements. The first allows object reads and writes in one
bucket. The second allows one parameter read:

<!-- verify: deploy/aws/policy.json at=aws-secrets -->
```json title="deploy/aws/policy.json"
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject"
      ],
      "Resource": "arn:aws:s3:::todo-backups/*"
    },
    {
      "Effect": "Allow",
      "Action": "ssm:GetParameter",
      "Resource": "arn:aws:ssm:us-east-1:000000000000:parameter/todo/admin-key"
    }
  ]
}
```

There is no `s3:ListBucket`, no `s3:DeleteObject`, and no wildcard parameter
ARN. The task can do its two jobs and nothing else. If the bucket name
changes, the policy changes; that is the point of naming the resource.

The resource ARN names the local emulator account. In a real account, replace
the account id in the policy document (or generate the document from it); the
script's role ARN already uses the account the CLI is pointed at.

The trust policy names ECS tasks as the principal:

<!-- verify: deploy/aws/trust.json at=aws-secrets -->
```json title="deploy/aws/trust.json"
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "ecs-tasks.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

A role without a trust policy cannot be assumed. The trust is the door; the
permission policy is what is allowed once inside.

## The bootstrap

The script creates the policy and role, attaches them, and stores the secret:

<!-- verify: deploy/aws/bootstrap-role.sh at=aws-secrets -->
```sh title="deploy/aws/bootstrap-role.sh"
#!/bin/sh
# deploy/aws/bootstrap-role.sh — create the task role and its secret.
#
# Run once per account. The policy is deliberately narrow: the task may write
# and read backups, and read one parameter. It may not list the bucket, delete
# objects, or read any other secret.
set -eu

POLICY_NAME=todo-task
ROLE_NAME=todo-task
PARAM_NAME=/todo/admin-key

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
POLICY_ARN="arn:aws:iam::${ACCOUNT}:policy/${POLICY_NAME}"

aws iam create-policy \
  --policy-name "$POLICY_NAME" \
  --policy-document file://deploy/aws/policy.json >/dev/null

aws iam create-role \
  --role-name "$ROLE_NAME" \
  --assume-role-policy-document file://deploy/aws/trust.json >/dev/null

aws iam attach-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-arn "$POLICY_ARN"

aws ssm put-parameter \
  --name "$PARAM_NAME" \
  --type SecureString \
  --value "${TODO_ADMIN_KEY:?set TODO_ADMIN_KEY}" \
  --overwrite >/dev/null

echo "role: ${ROLE_NAME}"
echo "policy: ${POLICY_ARN}"
echo "parameter: ${PARAM_NAME}"
```

The account id is read, not typed. The policy ARN is built from it, so the
same script works in another account. `--overwrite` makes the parameter step
idempotent; the role and policy creates are not, which is why this is a
bootstrap script, not a reconciliation loop.

Run it with the key supplied at the shell:

```bash
$ TODO_ADMIN_KEY=local-admin-key ./deploy/aws/bootstrap-role.sh
role: todo-task
policy: arn:aws:iam::000000000000:policy/todo-task
parameter: /todo/admin-key
```

The key is in the environment for the length of the command. It is not in
the script, the image, or the template. In a real terminal it is still in the
shell history if typed literally; use a secret prompt or a file with mode 600
for a production rotation.

## Read it back

The task's execution role reads the parameter and injects it. A human with
the right permission can read it the same way:

```bash
$ aws ssm get-parameter --name /todo/admin-key --with-decryption --query Parameter.Value --output text
local-admin-key
```

`--with-decryption` is required for a `SecureString`. Without it, AWS returns
the ciphertext. The local emulator keeps the shape of the call, though its
encryption is not a production KMS key; the command and the permission are
the lesson.

Check the role and its attachment:

```bash
$ aws iam get-role --role-name todo-task --query Role.Arn --output text
arn:aws:iam::000000000000:role/todo-task

$ aws iam list-attached-role-policies --role-name todo-task --query 'AttachedPolicies[].PolicyArn' --output text
arn:aws:iam::000000000000:policy/todo-task
```

The task definition's `Secrets` entry names the same parameter ARN. That is
the link: the template points at the parameter, the execution role is allowed
to read it, and the container receives `TODO_ADMIN_KEY` without a rebuild.

## Rotate it

Rotation is a `put-parameter` with `--overwrite` and a new value, followed by
a task replacement. The running task keeps the old value until it restarts;
a new task reads the new one. That is why the app treats the admin key as a
bootstrap credential, not a per-request password.

For a real deployment, use a rotation schedule and a secret manager that can
update the parameter. The application's job is to read the value at startup;
the platform's job is to deliver the new one.

## Test the policy, not just the call

The script proves the role can read the parameter and write the bucket. It does
not prove the role cannot delete an object, list the bucket, or read another
parameter. Those are the permissions the policy deliberately omits, and the
test for an omission is a denied call.

`aws iam simulate-principal-policy` answers the question without changing
anything: give it the role, the action, and the resource, and it returns
`allowed` or `implicitDeny`. A production policy is tested with a small matrix
of allowed and denied actions, the same way the store has a conformance suite.
The denied cases are the ones that catch a wildcard someone added to make a
demo work.

The other test is rotation. A policy that is correct but cannot be rotated
without downtime is a policy that will be bypassed. The parameter is versioned;
the task reads it at startup; the deploy replaces the task. The drill is to
rotate it once on purpose, before an incident forces the first attempt.

## If something went wrong

- **`AccessDenied` reading the parameter** — the role's resource ARN does not
  match the parameter's region, account, or name. The ARN is exact.
- **`InvalidClientTokenId`** — the CLI is pointed at a different endpoint or
  has no valid credentials. Check `AWS_ENDPOINT_URL` and the profile.
- **`ParameterNotFound`** — the parameter name is missing a leading slash, or
  the script ran in a different region. SSM names are region-scoped.
- **The task still sees the old key** — the task was not replaced. A secret
  update does not reach a running container; restart it.

<details>
<summary>Going deeper: roles, not users</summary>

A user has long-lived credentials. A role has none: a principal assumes it
and receives temporary credentials. That is why workloads should use roles.
The task's execution role is separate from the task role: the execution role
pulls the image and reads secrets, while the task role is what the running
code uses for S3. Mixing the two gives the application more power than it
needs.

The policy here is a starting point, not a complete production policy. A real
one also scopes by condition — source VPC, source account, encryption context
— and is tested with IAM Access Analyzer. The shape to keep is the same:
name the action, name the resource, and leave everything else out.

</details>

The task has an identity and a secret now. Next we make the same checks run
on every change, so a bad image never reaches the deploy.
