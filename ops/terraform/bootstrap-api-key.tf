# Optional API key for the container when bootstrap uses Docker. Aligned with Speakman-ai#571
# (generated key in Terraform state; store securely). Count uses only locals (not trimspace on null).
resource "random_id" "agent_hub_api_key" {
  count       = local.need_agent_hub_api_key ? 1 : 0
  byte_length = 32
}
