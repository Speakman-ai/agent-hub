# Common GCP Service Recipes

One section per major GCP service — key read commands and important write
commands (all writes require user confirmation first).

Back to [SKILL.md](../SKILL.md).

---

## Compute Engine

```bash
# List all instances
gcloud compute instances list \
  --format="table(name,zone,status,machineType.basename(),networkInterfaces[0].networkIP)"

# Running instances in a specific zone
gcloud compute instances list \
  --filter="status=RUNNING AND zone:us-central1-a" \
  --format="table(name,networkInterfaces[0].accessConfigs[0].natIP:label=EXTERNAL_IP)"

# Describe a specific instance
gcloud compute instances describe INSTANCE_NAME --zone=ZONE --format=yaml

# List disks
gcloud compute disks list --format="table(name,zone,sizeGb,type.basename(),status)"

# List firewall rules
gcloud compute firewall-rules list \
  --format="table(name,direction,priority,sourceRanges,targetTags,allowed)"

# List networks
gcloud compute networks list --format="table(name,subnetMode,autoCreateSubnetworks)"

# List subnets
gcloud compute networks subnets list --format="table(name,region,network,ipCidrRange)"

# SSH to an instance (WRITE — confirm first; opens interactive shell)
gcloud compute ssh INSTANCE_NAME --zone=ZONE

# Start / Stop instance (WRITE — confirm first)
gcloud compute instances start  INSTANCE_NAME --zone=ZONE
gcloud compute instances stop   INSTANCE_NAME --zone=ZONE

# Delete instance (DESTRUCTIVE — confirm first)
gcloud compute instances delete INSTANCE_NAME --zone=ZONE
```

---

## Cloud Storage (gsutil)

```bash
# List all buckets in the project
gsutil ls -p PROJECT_ID

# List objects in a bucket (top-level)
gsutil ls gs://my-bucket/

# List recursively with sizes
gsutil ls -r -l gs://my-bucket/

# Get bucket details (location, storage class, versioning)
gsutil ls -L -b gs://my-bucket/

# Get bucket ACL
gsutil acl get gs://my-bucket/

# Get object metadata
gsutil stat gs://my-bucket/path/to/object

# Copy file to GCS (WRITE — confirm first)
gsutil cp local-file.txt gs://my-bucket/path/file.txt

# Copy with dry-run (check before copying)
gsutil cp --dry-run local-file.txt gs://my-bucket/path/file.txt

# Sync directory to GCS (WRITE — confirm first; use -n for dry-run)
gsutil rsync -r -n ./dist/ gs://my-bucket/dist/    # dry-run
gsutil rsync -r    ./dist/ gs://my-bucket/dist/    # real sync

# Generate a signed URL (read access, 1 hour)
gsutil signurl -d 1h /path/to/sa-key.json gs://my-bucket/path/file.txt

# Delete object (DESTRUCTIVE — confirm first)
gsutil rm gs://my-bucket/path/to/object

# Delete bucket and all contents (DESTRUCTIVE — confirm first)
gsutil rm -r gs://my-bucket/
```

---

## BigQuery (bq)

```bash
# List datasets in a project
bq ls --project_id=PROJECT_ID

# List tables in a dataset
bq ls PROJECT_ID:DATASET

# Show table schema
bq show --format=prettyjson PROJECT_ID:DATASET.TABLE

# Run a query (dry-run first to check bytes processed)
bq query --dry_run --use_legacy_sql=false \
  'SELECT COUNT(*) FROM `PROJECT_ID.DATASET.TABLE`'

# Run query
bq query --use_legacy_sql=false --format=json \
  'SELECT name, value FROM `PROJECT_ID.DATASET.TABLE` LIMIT 10'

# Run query and save to destination table (WRITE — confirm first)
bq query --use_legacy_sql=false \
  --destination_table=PROJECT_ID:DATASET.OUTPUT_TABLE \
  'SELECT * FROM `PROJECT_ID.DATASET.SOURCE_TABLE`'

# Show job status
bq show --format=prettyjson -j JOB_ID

# List recent jobs
bq ls -j --all --max_results=20

# Delete table (DESTRUCTIVE — confirm first)
bq rm PROJECT_ID:DATASET.TABLE
```

---

## IAM

```bash
# List IAM roles granted on a project
gcloud projects get-iam-policy PROJECT_ID \
  --format="table(bindings.role,bindings.members)"

# Get full IAM policy as JSON
gcloud projects get-iam-policy PROJECT_ID --format=json

# List service accounts in a project
gcloud iam service-accounts list \
  --format="table(email,displayName,disabled)"

# List keys for a service account
gcloud iam service-accounts keys list \
  --iam-account=SA_EMAIL@PROJECT.iam.gserviceaccount.com \
  --format="table(name.basename(),validAfterTime,keyType)"

# Describe a role
gcloud iam roles describe roles/storage.objectViewer

# List predefined roles matching a keyword
gcloud iam roles list --filter="name:storage" \
  --format="table(name,title)"

# Add IAM binding (WRITE — confirm first)
gcloud projects add-iam-policy-binding PROJECT_ID \
  --member="user:alice@example.com" \
  --role="roles/viewer"

# Remove IAM binding (WRITE — confirm first)
gcloud projects remove-iam-policy-binding PROJECT_ID \
  --member="user:alice@example.com" \
  --role="roles/viewer"
```

---

## GKE (Google Kubernetes Engine)

```bash
# List clusters across the project
gcloud container clusters list \
  --format="table(name,zone,currentNodeCount,status,currentMasterVersion)"

# Describe a specific cluster
gcloud container clusters describe CLUSTER_NAME --zone=ZONE --format=yaml

# Fetch kubeconfig (gives kubectl access — no mutations; just updates ~/.kube/config)
gcloud container clusters get-credentials CLUSTER_NAME --zone=ZONE

# List node pools
gcloud container node-pools list --cluster=CLUSTER_NAME --zone=ZONE

# List operations (pending/running)
gcloud container operations list --zone=ZONE --filter="status!=DONE"

# Create a cluster (WRITE — confirm first)
gcloud container clusters create CLUSTER_NAME \
  --zone=ZONE \
  --num-nodes=3 \
  --machine-type=n1-standard-2

# Delete a cluster (DESTRUCTIVE — confirm first)
gcloud container clusters delete CLUSTER_NAME --zone=ZONE
```

---

## Cloud Run

```bash
# List services (managed platform)
gcloud run services list --platform=managed --region=REGION \
  --format="table(metadata.name,status.url,status.conditions[0].status:label=READY)"

# Describe a service
gcloud run services describe SERVICE_NAME --platform=managed --region=REGION --format=yaml

# List revisions
gcloud run revisions list --service=SERVICE_NAME --platform=managed --region=REGION \
  --format="table(metadata.name,status.conditions[0].status,spec.containers[0].image)"

# View traffic split
gcloud run services describe SERVICE_NAME --platform=managed --region=REGION \
  --format="value(status.traffic)"

# Deploy from existing image (WRITE — confirm first)
gcloud run deploy SERVICE_NAME \
  --image=gcr.io/PROJECT_ID/IMAGE:TAG \
  --platform=managed \
  --region=REGION \
  --allow-unauthenticated

# Update traffic split (WRITE — confirm first)
gcloud run services update-traffic SERVICE_NAME \
  --platform=managed \
  --region=REGION \
  --to-revisions=REVISION=100

# Delete a service (DESTRUCTIVE — confirm first)
gcloud run services delete SERVICE_NAME --platform=managed --region=REGION
```

---

## Cloud Functions

```bash
# List functions (2nd gen)
gcloud functions list --gen2 --format="table(name,state,runtime,trigger)"

# List functions (1st gen)
gcloud functions list --format="table(name,status,runtime,trigger)"

# Describe a function
gcloud functions describe FUNCTION_NAME --gen2 --region=REGION --format=yaml

# View function logs
gcloud functions logs read FUNCTION_NAME --gen2 --region=REGION --limit=50

# Deploy a function (WRITE — confirm first)
gcloud functions deploy FUNCTION_NAME \
  --gen2 \
  --runtime=nodejs20 \
  --region=REGION \
  --source=./src \
  --entry-point=myFunction \
  --trigger-http \
  --allow-unauthenticated

# Delete a function (DESTRUCTIVE — confirm first)
gcloud functions delete FUNCTION_NAME --gen2 --region=REGION
```

---

## Cloud Build

```bash
# List recent builds
gcloud builds list --limit=20 \
  --format="table(id,status,createTime,duration,source.repoSource.repoName:label=REPO)"

# Describe a specific build
gcloud builds describe BUILD_ID --format=yaml

# Stream logs for a running build
gcloud builds log --stream BUILD_ID

# Submit a build (WRITE — confirm first)
gcloud builds submit --config=cloudbuild.yaml .

# List build triggers
gcloud builds triggers list \
  --format="table(name,description,createTime)"
```

---

## Artifact Registry

```bash
# List repositories
gcloud artifacts repositories list \
  --format="table(name.basename(),format,location,createTime)"

# List Docker images in a repository
gcloud artifacts docker images list REGION-docker.pkg.dev/PROJECT_ID/REPO_NAME

# List image tags
gcloud artifacts docker tags list REGION-docker.pkg.dev/PROJECT_ID/REPO_NAME/IMAGE

# Delete an image tag (DESTRUCTIVE — confirm first)
gcloud artifacts docker tags delete REGION-docker.pkg.dev/PROJECT_ID/REPO_NAME/IMAGE:TAG
```

---

## Cloud Logging

```bash
# Read recent log entries (structured)
gcloud logging read "severity>=ERROR" --limit=20 --format=json

# Filter by resource type
gcloud logging read \
  'resource.type="gce_instance" AND resource.labels.instance_id="INSTANCE_ID"' \
  --limit=50 --format=json

# Filter by log name
gcloud logging read \
  'logName="projects/PROJECT_ID/logs/cloudaudit.googleapis.com%2Factivity"' \
  --limit=20 --freshness=1h --format=json

# Tail logs (streaming, Ctrl-C to stop)
gcloud beta logging tail \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="SERVICE_NAME"'

# List log sinks
gcloud logging sinks list --format="table(name,destination,filter)"

# List log buckets
gcloud logging buckets list --format="table(name,retentionDays,locked)"
```

---

## Cloud Monitoring / Metrics

```bash
# List metric descriptors
gcloud beta monitoring metrics list \
  --filter="metric.type:compute.googleapis.com" \
  --format="value(type)" | head -20

# List alert policies
gcloud alpha monitoring policies list \
  --format="table(displayName,conditions[0].displayName,enabled)"

# List notification channels
gcloud alpha monitoring channels list \
  --format="table(displayName,type,enabled)"
```
