# Secret References — op:// URI Scheme

The `op://` URI scheme lets you reference secrets symbolically — in config
files, env var definitions, and inline commands — without ever embedding the
plaintext value.

Back to [SKILL.md](../SKILL.md).

Docs: https://developer.1password.com/docs/cli/secret-reference-syntax

## Contents

- [URI syntax](#uri-syntax)
- [Special field names](#special-field-names)
- [Inline use with op read](#inline-use-with-op-read)
- [Template syntax for op inject](#template-syntax-for-op-inject)
- [Common pitfalls](#common-pitfalls)

## URI syntax

```
op://<vault>/<item>/<section>/<field>
op://<vault>/<item>/<field>          # shorthand when no section
```

| Component | Notes |
|-----------|-------|
| `vault`   | Vault name (case-insensitive) or UUID |
| `item`    | Item title (exact, case-insensitive) or UUID |
| `section` | Section name (optional; omit if item has no sections) |
| `field`   | Field label (case-insensitive) or UUID |

Examples:

```bash
op://Personal/My AWS Account/access_key_id
op://Shared/Production DB/connection_string
op://Employee/GitHub PAT/credential       # single-field item
```

## Special field names

1Password reserves a few canonical field names:

| Field label      | What it maps to |
|-----------------|-----------------|
| `username`       | Login username |
| `password`       | Login password |
| `credential`     | API credential (API Key category) |
| `notesPlain`     | Secure Note body |
| `TOTP`           | One-time password (current TOTP value) |

You can also reference by UUID: `op item get <UUID> --fields id=<fieldId>`.

## Inline use with op read

```bash
# Print the value of one field to stdout (masked in Agent Hub logs)
op read "op://Personal/AWS Dev/access_key_id"

# Assign to a variable without printing
DB_PASS=$(op read "op://Shared/Production DB/password")

# Use as a CLI argument
my-tool --api-key "$(op read "op://Shared/My API Key/credential")"
```

> **Agent Hub wrapper**: use `scripts/op-read.sh` instead of calling `op read`
> directly. The wrapper masks the resolved value in output so it never appears
> in model context or logs.

## Template syntax for op inject

`op inject` resolves `op://` references embedded inside a file and writes the
result to a destination. This is the preferred way to generate config files that
contain secrets (e.g. `.env`, `config.yaml`).

Template file (`.env.tpl`):

```env
DATABASE_URL=op://Shared/Production DB/connection_string
AWS_ACCESS_KEY_ID=op://Personal/AWS Dev/access_key_id
AWS_SECRET_ACCESS_KEY=op://Personal/AWS Dev/secret_access_key
API_KEY=op://Team/Service X/credential
```

Resolve it:

```bash
op inject -i .env.tpl -o .env        # write to file
op inject -i .env.tpl                # write to stdout (avoid — exposes values)
```

> **Prefer `-o <file>`** over stdout so the agent doesn't see the resolved
> values. The resolved file should be ephemeral (e.g. `.gitignore`'d,
> `/tmp/...`) and deleted after use.

Docs: https://developer.1password.com/docs/cli/secrets-config-files

## Common pitfalls

| Symptom | Cause | Fix |
|---------|-------|-----|
| `[ERROR] … 401` | Session not active or SA token invalid | See auth-modes.md |
| `[ERROR] item not found` | Spaces in item title not URL-encoded | Use item UUID or quote the title |
| `[ERROR] field not found` | Wrong field label | Run `op item get "<title>" --format json` to list field labels |
| `[ERROR] vault not found` | SA doesn't have vault access | Grant vault access in 1Password Integrations |
| TOTP is stale | TOTP field regenerates every 30 s | Call `op read` immediately before use, not in advance |
| Resolved template in git | Accidentally committed `.env` | Add `.env` to `.gitignore`; rotate any exposed secrets immediately |
