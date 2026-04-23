# First boot: clone, then either Docker (server image; default) or host PM2.
# CORS/ALB wiring in locals. Overlaps with ideas from https://github.com/Speakman-ai/agent-hub/pull/571
# (docker + .env + optional generated API key).
variable "bootstrap_agent_hub" {
  description = "If true, on first boot clone and start Agent Hub. Requires a new instance or user data change; see user_data_replace_on_change on the EC2 instance."
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
