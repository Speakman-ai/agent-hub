# Pagination & Output Formatting

Back to [SKILL.md](../SKILL.md).

---

## Pagination

Most AWS list/describe commands return paginated results. Default page size varies
by service (often 100–1000 items).

### Auto-paginate (fetch all pages automatically)

```bash
# --no-paginate follows all NextToken pages and merges results
aws ec2 describe-instances --no-paginate --output json
aws s3api list-objects-v2 --bucket my-bucket --no-paginate
aws iam list-users --no-paginate
```

> **Warning:** On large datasets, `--no-paginate` can be slow and return
> very large JSON. Use filters or manual pagination for production-scale buckets.

### Manual pagination

```bash
# First page (default max-items varies by service)
aws ec2 describe-instances --max-items 50 --output json > page1.json

# Extract the NextToken
NEXT="$(python3 -c "import sys,json; d=json.load(open('page1.json')); print(d.get('NextToken',''))")"

# Next page
aws ec2 describe-instances --max-items 50 --starting-token "${NEXT}" --output json > page2.json
```

### Bash loop over all pages

```bash
NEXT_TOKEN=""
while true; do
  if [[ -z "${NEXT_TOKEN}" ]]; then
    RESULT="$(aws ec2 describe-instances --max-items 100 --output json)"
  else
    RESULT="$(aws ec2 describe-instances --max-items 100 --starting-token "${NEXT_TOKEN}" --output json)"
  fi

  # Process this page
  echo "${RESULT}" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for r in d.get('Reservations', []):
    for i in r.get('Instances', []):
        print(i['InstanceId'], i['State']['Name'])
"

  NEXT_TOKEN="$(echo "${RESULT}" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('NextToken',''))" 2>/dev/null)"
  [[ -z "${NEXT_TOKEN}" ]] && break
done
```

### Page size vs. max-items

- `--page-size N` controls items per API call (network efficiency).
- `--max-items N` limits total items returned across all pages.
- These can be combined: `--page-size 50 --max-items 200` fetches 4 pages of 50.

---

## Output Formats

### JSON (default)

```bash
aws ec2 describe-instances --output json
```

Structured, machine-readable. Pipe to `jq` for post-processing.

### Table

```bash
aws ec2 describe-instances \
  --query 'Reservations[].Instances[].[InstanceId,State.Name,InstanceType]' \
  --output table
```

Good for human inspection. Requires `--query` to select scalar fields.

### Text

```bash
aws ec2 describe-instances \
  --query 'Reservations[].Instances[].InstanceId' \
  --output text
```

Tab-separated scalars. Good for shell scripting / `xargs`.

### YAML

```bash
aws cloudformation describe-stacks --output yaml
```

Available in AWS CLI v2. Readable for hierarchical data.

---

## Output Normalization Tips

### Count results

```bash
aws iam list-users --query 'length(Users)' --output text
```

### Totals / sums (use jq)

```bash
aws lambda list-functions \
  --query 'Functions[].MemorySize' \
  --output json \
  | jq 'add'
```

### Save output to file

```bash
aws ec2 describe-instances --output json > instances.json
```

### Prettify with jq

```bash
aws ec2 describe-instances | jq '.Reservations[].Instances[] | {id:.InstanceId, state:.State.Name}'
```

---

## Pagination Gotchas

| Issue | Cause | Fix |
|---|---|---|
| Missing items | No `--no-paginate` | Add `--no-paginate` or loop over pages |
| `NextToken` expired | Token stale (usually 24h) | Re-run from first page |
| Slow fetch | Large bucket/table | Use `--page-size` to tune; add `--max-items` cap |
| S3 `list-objects-v2` vs `list-objects` | V2 uses `ContinuationToken` not `NextToken` | Use `--starting-token` (CLI normalises both) |
