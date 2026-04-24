# Ergonomic wrappers around the Terraform workflow for agent-hub infrastructure.
#
# Every target takes `ENV=<name>`, which selects both the backend config
# (environments/<ENV>/backend.hcl) and the tfvars file
# (environments/<ENV>/<ENV>.tfvars).
#
# Examples:
#   make init  ENV=test123
#   make plan  ENV=test123
#   make apply ENV=test123

ENV ?=

# Helper that gates env-sensitive targets.
define require-env
$(if $(strip $(ENV)),,$(error ENV is required. Example: make $@ ENV=test123))
endef

TFVARS = environments/$(ENV)/$(ENV).tfvars
BACKEND = environments/$(ENV)/backend.hcl

.PHONY: init plan apply apply-plan destroy fmt validate output

init:
	$(call require-env)
	./scripts/tf-init.sh $(ENV)

plan:
	$(call require-env)
	terraform plan -var-file=$(TFVARS) -out=/tmp/$(ENV).plan

apply:
	$(call require-env)
	terraform apply -var-file=$(TFVARS)

# Safer: require an explicit plan file produced from the current state lineage.
apply-plan:
	$(call require-env)
	terraform apply /tmp/$(ENV).plan

destroy:
	$(call require-env)
	terraform destroy -var-file=$(TFVARS)

fmt:
	terraform fmt -recursive

validate:
	terraform validate

output:
	terraform output
