# Chapter 58 — keys and permissions

```text
$ TODO_ADMIN_KEY=local-admin-key ./deploy/aws/bootstrap-role.sh
role: todo-task
policy: arn:aws:iam::000000000000:policy/todo-task
parameter: /todo/admin-key

$ aws ssm get-parameter --name /todo/admin-key --with-decryption --query Parameter.Value --output text
local-admin-key

$ aws iam get-role --role-name todo-task --query Role.Arn --output text
arn:aws:iam::000000000000:role/todo-task

$ aws iam list-attached-role-policies --role-name todo-task --query 'AttachedPolicies[].PolicyArn' --output text
arn:aws:iam::000000000000:policy/todo-task
```
