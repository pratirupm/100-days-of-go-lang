---
title: "Day 67 — Onto the cloud"
description: "Describe the container as an ECS Fargate service, validate the template locally, and run the same image the task definition names. — Day 67 of 100 Days of Go Lang."
sidebar:
  order: 67
chapter: 56
style: production
---

**About 3 hours** · Part XII, day 1 of 5.

**You'll be able to:**

- run the container on a managed AWS service;
- compare the cloud shape with the single box from the deployment days.

---

The last part ran the app on a cluster made of containers on this laptop.
That cluster disappears when the laptop sleeps. A cloud is the same idea with
machines someone else keeps running, a network someone else maintains, and a
bill that arrives every month.

**AWS** is one such cloud. **ECS** is its container service. **Fargate** is
the version that runs containers without asking you to manage the machines
underneath. You describe a **task definition** — image, CPU, memory, ports,
environment — and a **service** keeps a chosen number of tasks running.

Today we write that description, validate it, and run the same image locally
so the container half is proven before any cloud credential is involved.

## The shape

The stack is one CloudFormation template. CloudFormation is AWS's
infrastructure-as-code service: the file is the desired state, and the
service creates or updates the resources to match.

<!-- verify: deploy/aws/stack.yaml at=aws-compute -->
```yaml title="deploy/aws/stack.yaml"
AWSTemplateFormatVersion: "2010-09-09"
Description: The todo server as an ECS Fargate service.

Parameters:
  Image:
    Type: String
    Description: The published server image, including its digest.
  ExecutionRoleArn:
    Type: String
    Description: ARN of the task execution role from the secrets day.
```

The two parameters are the values that change between environments: the
image and the task execution role. The image parameter is a name plus a
digest, not a mutable name; that is what makes a deployment reproducible. The
role is the one created in the secrets lesson; the bootstrap key itself lives
in SSM, not in this template.

The task definition is the container:

<!-- verify: deploy/aws/stack.yaml at=aws-compute -->
```yaml title="deploy/aws/stack.yaml"
  TaskDefinition:
    Type: AWS::ECS::TaskDefinition
    Properties:
      Family: todo-server
      ExecutionRoleArn: !Ref ExecutionRoleArn
      Cpu: "256"
      Memory: "512"
      NetworkMode: awsvpc
      RequiresCompatibilities:
        - FARGATE
      ContainerDefinitions:
        - Name: todo
          Image: !Ref Image
          Essential: true
          PortMappings:
            - ContainerPort: 8080
              Protocol: tcp
```

`Cpu: "256"` is a quarter of a vCPU; `Memory: "512"` is 512 MiB. Those are
Fargate's units, not Docker's. `awsvpc` gives the task its own network
interface, which is why the service needs a subnet. The container port is the
same 8080 the image exposes.

The environment and secret reference are the same settings the Kubernetes
ConfigMap and Secret carried:

<!-- verify: deploy/aws/stack.yaml at=aws-compute -->
```yaml title="deploy/aws/stack.yaml"
          Environment:
            - Name: TODO_LISTEN
              Value: ":8080"
            - Name: TODO_DB
              Value: /data/todo.db
            - Name: TODO_LOG
              Value: /data/todo.log
            - Name: TODO_ADMIN_EMAIL
              Value: admin@example.com
          Secrets:
            - Name: TODO_ADMIN_KEY
              ValueFrom: !Sub "arn:aws:ssm:${AWS::Region}:${AWS::AccountId}:parameter/todo/admin-key"
```

`Environment` is plain text; `Secrets` is a reference to Systems Manager
Parameter Store. The task's execution role reads the parameter and injects it
as an environment variable; the value never appears in the template.

The service keeps one task alive:

<!-- verify: deploy/aws/stack.yaml at=aws-compute -->
```yaml title="deploy/aws/stack.yaml"
  Service:
    Type: AWS::ECS::Service
    Properties:
      Cluster: !Ref Cluster
      DesiredCount: 1
      LaunchType: FARGATE
      TaskDefinition: !Ref TaskDefinition
      NetworkConfiguration:
        AwsvpcConfiguration:
          AssignPublicIp: ENABLED
          Subnets:
            - subnet-00000000000000001
```

`DesiredCount` is the same idea as `replicas` in the Deployment. The subnet
is a placeholder; a real stack passes its own. `AssignPublicIp` is convenient
for a demo and wrong for a private service behind a load balancer; the next
lessons add the pieces that make the private shape possible.

## Validate before you rent

The template can be checked without an AWS account. The `validate-template`
call parses it and reports the parameters and description:

```bash
$ aws cloudformation validate-template --template-body file://deploy/aws/stack.yaml
{
    "Parameters": [
...
    ],
    "Description": "The todo server as an ECS Fargate service."
}
```

This is a syntax and shape check, not a deployment. It catches a misspelled
resource type or a bad reference before a stack spends ten minutes failing in
the cloud. The local endpoint is an AWS-compatible emulator; the same command
runs against a real account with the endpoint removed.

The container half is proven with the same image and the same settings:

```bash
$ podman run -d --name todo-aws-shape -p 18083:8080 -e TODO_LISTEN=:8080 -e TODO_DB=/data/todo.db -e TODO_LOG=/data/todo.log -e TODO_ADMIN_EMAIL=admin@example.com -e TODO_ADMIN_KEY=local-admin-key localhost/todo:dev
10ea2ca585200e60e979a0e3ac7222780ab2ac8cbd9e86f7fbd3dc0d4bf64e4f
```

Ask it for readiness:

```bash
$ curl -sS -i http://127.0.0.1:18083/ready
HTTP/1.1 200 OK
Content-Security-Policy: default-src 'none'; script-src 'none'; style-src 'self'; img-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'
Content-Type: application/json
Referrer-Policy: no-referrer
...
{"status":"ok"}
```

The log shows the bootstrap and the request:

```bash
$ podman logs todo-aws-shape | tail -1
{"time":"2026-10-31T09:22:18.035574552Z","level":"INFO","msg":"request","request_id":"xLuFeqbMEKCgTYrApPoeDAgQyIcCVTjq","trace_id":"34de61de5d69c159617dc8f52c2372cc","method":"GET","path":"/ready","status":200,"duration":1012231}
```

The image works with the task definition's environment. What is still missing
is the cloud around it: a VPC, subnets, a load balancer, an execution role,
and a database that outlives a task.

## The bill and the teardown

A Fargate task bills for the CPU and memory it reserves, not the work it does.
A task with `Cpu: "256"` and `Memory: "512"` costs the same whether it serves
one request or a thousand. A service with `DesiredCount: 1` is one task; a
failed deployment that leaves two revisions running is two.

The template is deliberately small, but it is not free. A real exercise needs
a budget alarm, a teardown command, and a habit of deleting the stack at the
end of the day. The local emulator costs nothing and is the right place to
learn the shape; the cloud account is where the meter runs.

The teardown is part of the lesson, not an afterthought. `aws cloudformation
delete-stack` removes the service and the task definition; the image in the
registry and the parameter in SSM may outlive it. A stack that cannot be
deleted cleanly is a stack that will surprise the next person.

## The load balancer

A Fargate task has a private IP that changes when the task is replaced. A
browser cannot be pointed at it. The service needs a load balancer with a
stable DNS name, a target group, and a health check that calls `/ready`.

The target group's health check is the readiness probe's cloud cousin. A task
that fails it is removed from the target group; a task that passes is added.
The load balancer does not know about the app's sessions or its WebSocket
upgrade, so those need sticky sessions or a shared session store. The app's
sessions are in the database, which is why the split is possible.

## If something went wrong

- **`Template format error`** — CloudFormation rejected the YAML. Check
  indentation and the `!Ref` / `!Sub` names; a parameter typo is the usual
  cause.
- **`No credentials` or `Unable to locate credentials`** — the AWS CLI has no
  profile. For the local endpoint, export test credentials; for a real
  account, configure a profile and a region.
- **`CannotPullContainerError`** — the task cannot reach the image. The image
  must be in a registry the task can read; a local image name is not enough.
- **`ResourceInitializationError: unable to pull secrets`** — the execution
  role cannot read the SSM parameter. Check the parameter ARN, the region,
  and the role's `ssm:GetParameters` permission.

<details>
<summary>Going deeper: Fargate, EC2, and the bill</summary>

ECS can run tasks on Fargate or on EC2 instances you manage. Fargate removes
the node layer: you pay for the task's CPU and memory, and AWS handles the
host. EC2 gives you more control and a lower bill at steady, high
utilization, at the cost of patching and capacity planning.

A task definition is a versioned object. Registering a new revision is cheap;
the service moves to it when you update the service. That is the same
ReplicaSet-and-Deployment idea as Kubernetes, with different names. The
important shared rule is the same: the image is immutable, the desired count
is declarative, and the service closes the gap.

</details>

The container has a cloud shape now. Next we give its data a place that
outlives the task — object storage, with a backup that can be restored.

<div class="day-tracker" data-day="67"></div>
