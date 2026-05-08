# JMESPath Recipes

JMESPath is the query language used by `--query` in the AWS CLI.
Spec: https://jmespath.org/specification.html

Back to [SKILL.md](../SKILL.md).

---

## Syntax Cheatsheet

| Expression | Meaning |
|---|---|
| `Foo` | Field access |
| `Foo.Bar` | Nested field |
| `Foo[0]` | Array index |
| `Foo[]` | Flatten nested arrays |
| `Foo[*]` | Wildcard: all elements |
| `Foo[?Bar==\`val\`]` | Filter: elements where Bar == "val" (backtick strings) |
| `Foo[].[A,B]` | Project: pairs of values (array of arrays) |
| `Foo[].{A:A, B:B.Sub}` | Object projection (array of objects) |
| `Foo[] | [0]` | Pipe: pass result to next expression |
| `length(Foo)` | Built-in function: count |
| `sort_by(Foo, &Bar)` | Sort by field (ascending) |
| `reverse(sort_by(...))` | Sort descending |
| `max_by(Foo, &Bar)` | Element with maximum value |
| `min_by(Foo, &Bar)` | Element with minimum value |
| `contains(Foo, \`val\`)` | True if array/string contains val |
| `starts_with(Str, \`pfx\`)` | String prefix check |
| `not_null(A, B, C)` | First non-null value |

---

## Practical Recipes

### EC2 — list running instances

```bash
aws ec2 describe-instances \
  --query 'Reservations[].Instances[?State.Name==`running`].[InstanceId,PrivateIpAddress,InstanceType]' \
  --output table
```

### EC2 — get Name tag for each instance

```bash
aws ec2 describe-instances \
  --query 'Reservations[].Instances[].[InstanceId,Tags[?Key==`Name`].Value|[0]]' \
  --output table
```

### EC2 — find instances with a specific tag value

```bash
aws ec2 describe-instances \
  --filters "Name=tag:Env,Values=production" \
  --query 'Reservations[].Instances[].InstanceId' \
  --output text
```

### S3 — list buckets sorted by creation date (jq required for sort)

```bash
aws s3api list-buckets \
  --query 'Buckets[].{Name:Name,Created:CreationDate}' \
  | jq 'sort_by(.Created) | reverse'
```

### IAM — list users with their creation dates

```bash
aws iam list-users \
  --query 'Users[].{Name:UserName,Created:CreateDate,Arn:Arn}' \
  --output table
```

### Lambda — list functions by runtime

```bash
aws lambda list-functions \
  --query 'Functions[?Runtime==`python3.12`].FunctionName' \
  --output text
```

### Lambda — all functions sorted by size (jq for sort)

```bash
aws lambda list-functions \
  --query 'Functions[].{Name:FunctionName,Runtime:Runtime,MB:MemorySize,CodeSize:CodeSize}' \
  | jq 'sort_by(.CodeSize) | reverse'
```

### ECS — list services in a cluster

```bash
aws ecs list-services --cluster my-cluster --query 'serviceArns[]' --output text
```

### CloudWatch — last 10 log events

```bash
aws logs get-log-events \
  --log-group-name /aws/lambda/my-function \
  --log-stream-name "$(aws logs describe-log-streams \
      --log-group-name /aws/lambda/my-function \
      --order-by LastEventTime --descending \
      --query 'logStreams[0].logStreamName' --output text)" \
  --limit 10 \
  --query 'events[].message' \
  --output text
```

### CloudFormation — list stack outputs

```bash
aws cloudformation describe-stacks \
  --stack-name my-stack \
  --query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' \
  --output table
```

### SSM — get parameter value

```bash
aws ssm get-parameter \
  --name /my/app/db-password \
  --with-decryption \
  --query 'Parameter.Value' \
  --output text
```

### Cost Explorer — monthly spend

```bash
aws ce get-cost-and-usage \
  --time-period Start=2026-04-01,End=2026-05-01 \
  --granularity MONTHLY \
  --metrics UnblendedCost \
  --query 'ResultsByTime[0].Total.UnblendedCost.{Amount:Amount,Unit:Unit}'
```

---

## Filtering Tips

### Filter + project in one expression

```bash
# Running EC2 instances: just IDs
aws ec2 describe-instances \
  --query 'Reservations[].Instances[?State.Name==`running`].InstanceId[]'
```

### Flatten nested arrays (`[]` vs `[*]`)

`[]` flattens one level; `[*]` preserves the array structure:

```bash
# Flat list of all instance IDs across all reservations
--query 'Reservations[].Instances[].InstanceId'
# vs. list of ID-arrays (one per reservation)
--query 'Reservations[*].Instances[*].InstanceId'
```

### Combining JMESPath with `jq`

When JMESPath isn't enough (sorting, grouping, arithmetic):

```bash
aws ec2 describe-instances \
  --query 'Reservations[].Instances[]' \
  | jq '[.[] | {id:.InstanceId, type:.InstanceType, state:.State.Name}] | sort_by(.type)'
```

---

## Common Gotchas

| Issue | Cause | Fix |
|---|---|---|
| `Invalid jmespath expression` | Unescaped backticks in shell | Use single quotes around `--query` value |
| No output / empty list | Filter too narrow | Remove filter, inspect raw JSON, then re-add |
| `null` values | Field doesn't exist | Use `not_null(A, B)` or `|| \`N/A\`` |
| Quoted strings in filter | Use backticks, not quotes | `[?State==\`running\`]` not `[?State=="running"]` |
