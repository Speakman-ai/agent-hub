# Common Service Recipes

One section per major AWS service — key read commands and important write
commands (all writes require user confirmation first).

Back to [SKILL.md](../SKILL.md).

---

## EC2

```bash
# List all instances (ID, state, type, AZ)
aws ec2 describe-instances \
  --query 'Reservations[].Instances[].[InstanceId,State.Name,InstanceType,Placement.AvailabilityZone]' \
  --output table

# Running instances only
aws ec2 describe-instances \
  --filters "Name=instance-state-name,Values=running" \
  --query 'Reservations[].Instances[].[InstanceId,PrivateIpAddress,Tags[?Key==`Name`].Value|[0]]' \
  --output table

# Security groups — open ports
aws ec2 describe-security-groups \
  --query 'SecurityGroups[].[GroupId,GroupName,IpPermissions[]]' \
  --output json

# Key pairs
aws ec2 describe-key-pairs --query 'KeyPairs[].KeyName' --output text

# Start / stop instance (WRITE — confirm first)
aws ec2 start-instances  --instance-ids i-0123456789abcdef0
aws ec2 stop-instances   --instance-ids i-0123456789abcdef0

# Terminate instance (DESTRUCTIVE — confirm first)
aws ec2 terminate-instances --instance-ids i-0123456789abcdef0
```

---

## S3

```bash
# List buckets
aws s3api list-buckets --query 'Buckets[].{Name:Name,Created:CreationDate}' --output table

# List objects in a bucket (top-level)
aws s3 ls s3://my-bucket/

# List recursively with sizes
aws s3 ls s3://my-bucket/ --recursive --human-readable --summarize

# Get bucket ACL
aws s3api get-bucket-acl --bucket my-bucket

# Public access block settings
aws s3api get-public-access-block --bucket my-bucket

# Bucket policy
aws s3api get-bucket-policy --bucket my-bucket --query Policy --output text | python3 -m json.tool

# Copy file (WRITE — confirm first)
aws s3 cp local-file.txt s3://my-bucket/path/file.txt

# Delete object (DESTRUCTIVE — confirm first)
aws s3 rm s3://my-bucket/path/file.txt

# Sync directory (WRITE — confirm first, use --dryrun first)
aws s3 sync ./dist/ s3://my-bucket/dist/ --dryrun
aws s3 sync ./dist/ s3://my-bucket/dist/
```

---

## IAM

```bash
# List users
aws iam list-users --query 'Users[].{Name:UserName,Created:CreateDate}' --output table

# List roles
aws iam list-roles --query 'Roles[].{Name:RoleName,Arn:Arn}' --output table

# List groups
aws iam list-groups --query 'Groups[].GroupName' --output text

# Get policies attached to a role
aws iam list-attached-role-policies --role-name MyRole --query 'AttachedPolicies[].PolicyName' --output text

# Get inline policies
aws iam list-role-policies --role-name MyRole

# Access keys (metadata only — no secrets)
aws iam list-access-keys --user-name myuser --query 'AccessKeyMetadata[].[AccessKeyId,Status,CreateDate]' --output table

# Simulate policy (read)
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::123456789012:role/MyRole \
  --action-names s3:GetObject \
  --resource-arns arn:aws:s3:::my-bucket/*

# Create user (WRITE — confirm first)
aws iam create-user --user-name newuser
```

---

## Lambda

```bash
# List functions
aws lambda list-functions \
  --query 'Functions[].{Name:FunctionName,Runtime:Runtime,MB:MemorySize,Updated:LastModified}' \
  --output table

# Get function config
aws lambda get-function-configuration --function-name my-function

# Get environment variables (may contain secrets — handle carefully)
aws lambda get-function-configuration \
  --function-name my-function \
  --query 'Environment.Variables'

# Invoke function (WRITE — confirm first)
aws lambda invoke \
  --function-name my-function \
  --payload '{"key":"value"}' \
  --cli-binary-format raw-in-base64-out \
  /tmp/lambda-response.json && cat /tmp/lambda-response.json

# Tail logs (uses CloudWatch Logs)
aws logs tail /aws/lambda/my-function --follow
```

---

## ECS / EKS

```bash
# ECS — list clusters
aws ecs list-clusters --query 'clusterArns[]' --output text

# ECS — list services in a cluster
aws ecs list-services --cluster my-cluster --query 'serviceArns[]' --output text

# ECS — describe service
aws ecs describe-services --cluster my-cluster --services my-service \
  --query 'services[0].{Status:status,Running:runningCount,Desired:desiredCount}'

# ECS — list tasks
aws ecs list-tasks --cluster my-cluster --service-name my-service

# ECS — scale service (WRITE — confirm first)
aws ecs update-service --cluster my-cluster --service my-service --desired-count 3

# EKS — list clusters
aws eks list-clusters --query 'clusters[]' --output text

# EKS — get kubeconfig
aws eks update-kubeconfig --name my-cluster --region us-east-1
```

---

## RDS

```bash
# List DB instances
aws rds describe-db-instances \
  --query 'DBInstances[].[DBInstanceIdentifier,DBInstanceStatus,Engine,DBInstanceClass]' \
  --output table

# List snapshots
aws rds describe-db-snapshots \
  --query 'DBSnapshots[].[DBSnapshotIdentifier,Status,SnapshotCreateTime]' \
  --output table

# Get connection endpoint
aws rds describe-db-instances \
  --db-instance-identifier my-db \
  --query 'DBInstances[0].Endpoint.{Host:Address,Port:Port}'

# Create snapshot (WRITE — confirm first)
aws rds create-db-snapshot \
  --db-instance-identifier my-db \
  --db-snapshot-identifier my-db-snap-$(date +%Y%m%d)
```

---

## DynamoDB

```bash
# List tables
aws dynamodb list-tables --query 'TableNames[]' --output text

# Describe table
aws dynamodb describe-table --table-name MyTable \
  --query 'Table.{Status:TableStatus,Items:ItemCount,SizeBytes:TableSizeBytes}'

# Scan table (read — use sparingly on large tables)
aws dynamodb scan --table-name MyTable --limit 10

# Query table
aws dynamodb query \
  --table-name MyTable \
  --key-condition-expression "PK = :pk" \
  --expression-attribute-values '{":pk":{"S":"user#123"}}'

# Put item (WRITE — confirm first)
aws dynamodb put-item \
  --table-name MyTable \
  --item '{"PK":{"S":"user#123"},"SK":{"S":"profile"},"name":{"S":"Alice"}}'
```

---

## CloudWatch (Logs & Metrics)

```bash
# List log groups
aws logs describe-log-groups \
  --query 'logGroups[].{Name:logGroupName,RetentionDays:retentionInDays}' \
  --output table

# List log streams (most recent first)
aws logs describe-log-streams \
  --log-group-name /aws/lambda/my-function \
  --order-by LastEventTime --descending --limit 5 \
  --query 'logStreams[].{Stream:logStreamName,Last:lastEventTimestamp}'

# Tail log group (real-time)
aws logs tail /aws/lambda/my-function --follow

# CloudWatch Logs Insights query
aws logs start-query \
  --log-group-name /aws/lambda/my-function \
  --start-time $(date -d '1 hour ago' +%s 2>/dev/null || date -v-1H +%s) \
  --end-time $(date +%s) \
  --query-string 'fields @timestamp, @message | filter @message like /ERROR/ | limit 20'
# Then poll:
aws logs get-query-results --query-id <id-from-above>

# EC2 CPU metric (last hour, 5-min periods)
aws cloudwatch get-metric-statistics \
  --namespace AWS/EC2 \
  --metric-name CPUUtilization \
  --dimensions Name=InstanceId,Value=i-0123456789abcdef0 \
  --start-time $(date -u -d '1 hour ago' +%FT%TZ 2>/dev/null || date -u -v-1H +%FT%TZ) \
  --end-time $(date -u +%FT%TZ) \
  --period 300 \
  --statistics Average \
  --query 'Datapoints[].[Timestamp,Average]' \
  --output table
```

---

## CloudFormation

```bash
# List stacks
aws cloudformation list-stacks \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE \
  --query 'StackSummaries[].{Name:StackName,Status:StackStatus}' \
  --output table

# Describe stack
aws cloudformation describe-stacks --stack-name my-stack \
  --query 'Stacks[0].{Status:StackStatus,Outputs:Outputs}'

# List stack resources
aws cloudformation list-stack-resources --stack-name my-stack \
  --query 'StackResourceSummaries[].[LogicalResourceId,ResourceType,ResourceStatus]' \
  --output table

# Get stack events (recent)
aws cloudformation describe-stack-events --stack-name my-stack \
  --query 'StackEvents[:10].[Timestamp,LogicalResourceId,ResourceStatus,ResourceStatusReason]' \
  --output table

# Deploy stack (WRITE — confirm first)
aws cloudformation deploy \
  --template-file template.yaml \
  --stack-name my-stack \
  --capabilities CAPABILITY_IAM
```

---

## Route53

```bash
# List hosted zones
aws route53 list-hosted-zones \
  --query 'HostedZones[].[Id,Name,Config.PrivateZone]' \
  --output table

# List records in a zone
aws route53 list-resource-record-sets \
  --hosted-zone-id Z1234567890 \
  --query 'ResourceRecordSets[].[Name,Type,TTL]' \
  --output table
```

---

## SSM Parameter Store

```bash
# List parameters (names only)
aws ssm describe-parameters \
  --query 'Parameters[].{Name:Name,Type:Type,LastModified:LastModifiedDate}' \
  --output table

# Get parameter value (plain)
aws ssm get-parameter --name /my/app/config --query 'Parameter.Value' --output text

# Get SecureString parameter (decrypted)
aws ssm get-parameter --name /my/app/secret --with-decryption --query 'Parameter.Value' --output text

# Put parameter (WRITE — confirm first)
aws ssm put-parameter \
  --name /my/app/config \
  --value "my-value" \
  --type String \
  --overwrite
```

---

## Secrets Manager

```bash
# List secrets
aws secretsmanager list-secrets \
  --query 'SecretList[].{Name:Name,LastChanged:LastChangedDate}' \
  --output table

# Get secret value (shows plaintext — handle carefully)
aws secretsmanager get-secret-value \
  --secret-id my-secret \
  --query 'SecretString' \
  --output text

# Describe secret (no value exposed)
aws secretsmanager describe-secret --secret-id my-secret

# Create secret (WRITE — confirm first)
aws secretsmanager create-secret --name my-secret --secret-string '{"username":"admin","password":"..."}'
```

---

## KMS

```bash
# List keys
aws kms list-keys --query 'Keys[].KeyId' --output text

# Describe a key
aws kms describe-key --key-id alias/my-key \
  --query 'KeyMetadata.{Id:KeyId,Arn:Arn,State:KeyState,Usage:KeyUsage}'

# List aliases
aws kms list-aliases --query 'Aliases[].[AliasName,TargetKeyId]' --output table
```

---

## SQS

```bash
# List queues
aws sqs list-queues --query 'QueueUrls[]' --output text

# Get queue attributes (including message count)
aws sqs get-queue-attributes \
  --queue-url https://sqs.us-east-1.amazonaws.com/123456789012/my-queue \
  --attribute-names ApproximateNumberOfMessages,ApproximateNumberOfMessagesNotVisible

# Receive messages (non-destructive peek)
aws sqs receive-message \
  --queue-url https://sqs.us-east-1.amazonaws.com/123456789012/my-queue \
  --max-number-of-messages 1

# Send message (WRITE — confirm first)
aws sqs send-message \
  --queue-url https://sqs.us-east-1.amazonaws.com/123456789012/my-queue \
  --message-body '{"event":"test"}'
```

---

## SNS

```bash
# List topics
aws sns list-topics --query 'Topics[].TopicArn' --output text

# List subscriptions
aws sns list-subscriptions --query 'Subscriptions[].[TopicArn,Protocol,Endpoint]' --output table

# Publish message (WRITE — confirm first)
aws sns publish \
  --topic-arn arn:aws:sns:us-east-1:123456789012:my-topic \
  --message '{"event":"test"}' \
  --subject "Test notification"
```

---

## EventBridge

```bash
# List event buses
aws events list-event-buses --query 'EventBuses[].{Name:Name,Arn:Arn}' --output table

# List rules on default bus
aws events list-rules --query 'Rules[].{Name:Name,State:State,Schedule:ScheduleExpression}' --output table

# Describe a rule
aws events describe-rule --name my-rule

# List targets for a rule
aws events list-targets-by-rule --rule my-rule --query 'Targets[].[Id,Arn]' --output table
```

---

## Cost Explorer

```bash
# Monthly total cost (current month)
aws ce get-cost-and-usage \
  --time-period Start=$(date +%Y-%m-01),End=$(date -d 'next month' +%Y-%m-01 2>/dev/null || date -v+1m +%Y-%m-01) \
  --granularity MONTHLY \
  --metrics UnblendedCost \
  --query 'ResultsByTime[0].Total.UnblendedCost.{Amount:Amount,Unit:Unit}'

# Cost by service (last 30 days)
aws ce get-cost-and-usage \
  --time-period Start=$(date -d '30 days ago' +%F 2>/dev/null || date -v-30d +%F),End=$(date +%F) \
  --granularity MONTHLY \
  --metrics UnblendedCost \
  --group-by Type=DIMENSION,Key=SERVICE \
  --query 'ResultsByTime[].Groups[].[Keys[0],Metrics.UnblendedCost.Amount]' \
  --output table \
  | sort -t$'\t' -k2 -rn | head -20
```
