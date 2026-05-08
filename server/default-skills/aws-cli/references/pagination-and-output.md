# Pagination & Output Formatting

Back to [SKILL.md](../SKILL.md).

---

## Pagination

AWS CLI v2 **auto-paginates by default.** For list/describe commands the CLI
silently follows all `NextToken` / `ContinuationToken` pages and concatenates
the results into a single response. You do not need to add any flag to get
complete results.

### Default behaviour — all pages returned automatically

```bash
# No extra flags needed; the CLI fetches all pages and merges them.
aws ec2 describe-instances --output json
aws s3api list-objects-v2 --bucket my-bucket --output json
aws iam list-users --output json
```

> **Warning:** On large datasets (huge S3 buckets, accounts with thousands of
> IAM users) this can be slow and return very large JSON. Use `--max-items` or
> `--no-paginate` to cap the result set.

### `--no-paginate` — **first page only**

`--no-paginate` **disables** auto-pagination. The CLI returns only the first
page of results. Use it when you want a quick sample or intend to walk pages
manually:

```bash
# First page only — fast, but may miss items beyond the first page
aws ec2 describe-instances --no-paginate --output json
aws s3api list-objects-v2 --bucket my-bucket --no-paginate
aws iam list-users --no-paginate
```

### Manual pagination

```bash
# First page (default max-items varies by service)
aws ec2 describe-instances --max-items 50 --output json > page1.json

# Extract the NextToken (uses jq; alternatively: --query NextToken --output text)
NEXT="$(jq -r '.NextToken // empty' page1.json)"

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
  echo "${RESULT}" | jq -r '.Reservations[].Instances[] | [.InstanceId, .State.Name] | @tsv'

  NEXT_TOKEN="$(echo "${RESULT}" | jq -r '.NextToken // empty' 2>/dev/null)"
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
| Missing items on first call | `--no-paginate` was passed (first page only) | Remove `--no-paginate`; CLI auto-paginates by default |
| `NextToken` expired | Token stale (usually 24h) | Re-run from first page |
| Slow fetch | Large bucket/table | Use `--page-size` to tune; add `--max-items` cap |
| S3 `list-objects-v2` vs `list-objects` | V2 uses `ContinuationToken` not `NextToken` | Use `--starting-token` (CLI normalises both) |
