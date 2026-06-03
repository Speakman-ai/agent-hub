output "cluster_name" {
  value = aws_ecs_cluster.fleet.name
}

output "capacity_provider" {
  value = aws_ecs_capacity_provider.fleet.name
}

output "agent_service" {
  value = aws_ecs_service.agent.name
}

output "log_group" {
  value = aws_cloudwatch_log_group.runner.name
}

output "cache_bucket" {
  value = var.cache_bucket_name
}

output "worktree_bucket" {
  value = var.worktree_bucket_name
}

output "app_ecr_repo" {
  value = var.manage_shared_finalize_infra ? aws_ecr_repository.app[0].repository_url : null
}
