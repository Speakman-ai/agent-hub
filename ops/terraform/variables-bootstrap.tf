# First boot: clone, then either Docker (server image; default) or host PM2.
# CORS/ALB wiring in locals. Overlaps with ideas from https://github.com/Speakman-ai/agent-hub/pull/571
# (docker + .env + optional generated API key).
variable "bootstrap_agent_hub" {
  description = "If true, on first boot clone and start Agent Hub. Changing bootstrap inputs after launch never replaces the instance; the live host adopts the new env via ops/scripts/sync-hub-env.sh (SSM). See the `aws_instance.app` lifecycle in main.tf."
  type        = bool
  default     = false
}

variable "agent_hub_bootstrap_docker" {
  description = "When true, install Docker, clone, build server/Dockerfile, and run a container (see agent_hub_target_port). When false, use legacy Node + PM2 on the host. IGNORED when `agent_hub_image_uri` is non-empty — that selects the ECR-pull path, which skips clone and build entirely."
  type        = bool
  default     = true
}

variable "agent_hub_image_uri" {
  description = "Fully-qualified container image URI including tag (e.g. `public.ecr.aws/h9t4v7h0/agent-hub:main` or `public.ecr.aws/h9t4v7h0/agent-hub:<git-sha>`). When non-empty, user-data runs `docker pull && docker run` and skips git clone + docker build entirely. This is the recommended path going forward — CI pushes images on merge to main and Terraform just consumes the tag. Leave empty to fall through to the legacy clone+build path (requires `github_token_for_git_clone`)."
  type        = string
  default     = ""
}

variable "agent_hub_api_key" {
  description = "AGENT_HUB_API_KEY for the app. If null/empty, a key is generated (sensitive output). Used when agent_hub_bootstrap_docker = true only."
  type        = string
  default     = null
  sensitive   = true
}

variable "agent_hub_git_url" {
  description = "HTTPS URL to git clone (e.g. https://github.com/org/agent-hub.git). For private repos, set github_token_for_git_clone (sensitive) or a URL that embeds a token you control. Required (https://) when bootstrap_agent_hub = true; enforced in check \"agent_hub_bootstrap_git\"."
  type        = string
  default     = ""
}

variable "agent_hub_git_ref" {
  description = "Branch or tag to check out when bootstrap_agent_hub is true."
  type        = string
  default     = "main"
}

variable "github_token_for_git_clone" {
  description = "Required for a private agent_hub_git_url. Export TF_VAR_github_token_for_git_clone before apply. Terraform rewrites https://github.com/... to embed the token for non-interactive git clone. Use a fine-scoped classic PAT (repo) or a GitHub app token. Absent: clone fails, nothing listens on 3051, ALB health checks time out (504/502)."
  type        = string
  default     = null
  sensitive   = true
}

variable "agent_hub_allowed_origins" {
  description = "Comma-separated browser origins for the API (ALLOWED_ORIGINS on the server). If null and enable_dedicated_alb is true, default is https://<ALB FQDN>. If null and no dedicated ALB, you must set this in tfvars (cannot infer a public web URL from Terraform alone)."
  type        = string
  default     = null
  nullable    = true
}

variable "agent_hub_repo_basename" {
  description = "Subdirectory name under the app user home (clone target is /home/<app_user>/<basename>)."
  type        = string
  default     = "agent-hub"
}

variable "agent_hub_trust_proxy" {
  description = "X-Forwarded-For trust: number of reverse-proxy hops in front of Node (1 for one AWS ALB). If null, use 1 when enable_dedicated_alb is true, else 0 (only loopback, same as unset TRUST_PROXY)."
  type        = number
  default     = null
  nullable    = true
}

# ── Default Owner credentials on first launch ──────────────────────────────────
# When set, the server auto-creates the Owner account on first boot from these
# env vars (server/auth-bootstrap.ts). After auth.json exists subsequent boots
# are no-ops, so changing the value later does NOT rotate the password.

variable "agent_hub_default_username" {
  description = "Username for the auto-provisioned Owner on first boot. Empty/null disables and uses the server's built-in default ('admin'). Validated against the same allowlist as /api/auth/setup: 1–64 chars of [a-zA-Z0-9_.-@]."
  type        = string
  default     = "admin"
}

variable "agent_hub_default_password" {
  description = "Password used by server/auth-bootstrap.ts to auto-provision the Owner account on first boot. Three modes: empty/null disables auto-provision (operator must hit /api/auth/setup); a literal value (≥12 chars) is used as-is; the keyword `auto` generates a random password and writes it to <dataDir>/initial-credentials.txt (mode 0600) on the instance — retrieve via SSM Session Manager. Idempotent: once auth.json exists, this is ignored."
  type        = string
  default     = "auto"
  sensitive   = true
}

# ── Self log-shipping (server/log-shipper.ts) ──────────────────────────────────
# When agent_hub_ahlog_token is set, the Hub forwards its own captured console
# output to Agent Hub's JSON-batch log-ingest endpoint. Empty/null disables it
# (the shipper is a no-op without a token). Mint the token from a Hub log source
# (POST /api/projects/<slug>/log-sources — the 201 `token` is the plaintext
# `ahlog_…`, shown once) and store it in GitHub secret AGENT_HUB_AHLOG_TOKEN
# (release injects TF_VAR_agent_hub_ahlog_token) or a local secrets.tfvars
# overlay — never commit the token.

variable "agent_hub_ahlog_token" {
  description = "AHLOG_TOKEN for server/log-shipper.ts. The plaintext `ahlog_` ingest token minted from a Hub log source. Empty/null disables self log-shipping. Sensitive — supply via GitHub secret AGENT_HUB_AHLOG_TOKEN (CI) or secrets.tfvars (local), never commit it."
  type        = string
  default     = ""
  sensitive   = true
}

variable "agent_hub_ahlog_endpoint" {
  description = "Optional AHLOG_ENDPOINT override (JSON-batch ingest URL, e.g. https://<your-hub-domain>/api/logs/ingest). Empty ships to the server's own loopback ingest route on AGENT_HUB_PORT."
  type        = string
  default     = ""
}

variable "agent_hub_ahlog_service" {
  description = "Optional AHLOG_SERVICE override (service.name attribute on shipped logs). Empty uses the server default ('agent-hub')."
  type        = string
  default     = ""
}

variable "agent_hub_ahlog_environment" {
  description = "Optional AHLOG_ENVIRONMENT override (deployment.environment attribute on shipped logs). Empty uses the server default ('production')."
  type        = string
  default     = ""
}
