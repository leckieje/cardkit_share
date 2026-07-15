# Deployment Instructions — CardKit WSJ Pro

## Service Details

| Property | Value |
|---|---|
| **Cloud Run service** | `cardkit-wsjpro` |
| **Project** | `dj-newsrm-stag-aiml` |
| **Region** | `us-central1` |
| **URL** | https://cardkit-wsjpro-673850123387.us-central1.run.app |

## How to deploy

Deployment is a two-step process. The build and deploy steps must be run separately because `gcloud run deploy --source .` triggers the build successfully but the deploy step fails due to a permissions gap.

### Step 1 — Build the image via Cloud Build

The Dockerfile requires a `google-sheets/` directory that lives in the parent `sandbox/` folder. Copy it in first, then trigger the build, then clean up:

```bash
cp -r ../google-sheets ./google-sheets && \
gcloud run deploy cardkit-wsjpro \
  --source . \
  --region=us-central1 \
  --project=dj-newsrm-stag-aiml ; \
rm -rf ./google-sheets
```

This will fail at the deploy step — that's expected. The Cloud Build job still completes and pushes a new image to Artifact Registry.

### Step 2 — Get the new image digest

```bash
gcloud artifacts docker images list \
  us-central1-docker.pkg.dev/dj-newsrm-stag-aiml/cloud-run-source-deploy/cardkit-wsjpro \
  --project=dj-newsrm-stag-aiml \
  --limit=1 \
  --format='value(DIGEST)'
```

### Step 3 — Deploy the image to Cloud Run

Replace `<DIGEST>` with the sha256 digest from step 2:

```bash
gcloud run deploy cardkit-wsjpro \
  --image="us-central1-docker.pkg.dev/dj-newsrm-stag-aiml/cloud-run-source-deploy/cardkit-wsjpro@<DIGEST>" \
  --region=us-central1 \
  --project=dj-newsrm-stag-aiml \
  --platform=managed \
  --allow-unauthenticated \
  --port=8080 \
  --memory=1Gi \
  --cpu=1 \
  --min-instances=0 \
  --max-instances=3 \
  --set-env-vars="NODE_ENV=production,SHEETS_SERVICE_PORT=5050,GCS_BUCKET=dj-newsroom-stag-shared,GCS_PREFIX=jon_leckie"
```

## Notes

- `deploy.sh` in the repo root attempts a local Docker build + push and will fail — ignore it.
- The build step requires Cloud Build to have access to the `google-sheets` sibling directory. If that directory is missing, the build may fail.
