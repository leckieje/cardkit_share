#!/bin/bash
set -e

PROJECT_ID="${GCP_PROJECT:-dj-newsrm-stag-aiml}"
REGION="${GCP_REGION:-us-central1}"
SERVICE_NAME="cardkit-wsjpro"
REPO="us-central1-docker.pkg.dev/${PROJECT_ID}/cardkit"
IMAGE="${REPO}/${SERVICE_NAME}"
TAG="${1:-latest}"

echo "==> Copying google-sheets module into build context..."
rm -rf google-sheets
cp -r ../google-sheets ./google-sheets

echo "==> Building Docker image..."
docker build -t "${IMAGE}:${TAG}" .

echo "==> Cleaning up google-sheets copy..."
rm -rf google-sheets

echo "==> Pushing to Artifact Registry..."
docker push "${IMAGE}:${TAG}"

echo "==> Deploying to Cloud Run..."
gcloud run deploy "${SERVICE_NAME}" \
  --image="${IMAGE}:${TAG}" \
  --region="${REGION}" \
  --project="${PROJECT_ID}" \
  --platform=managed \
  --allow-unauthenticated \
  --port=8080 \
  --memory=1Gi \
  --cpu=1 \
  --min-instances=0 \
  --max-instances=3 \
  --set-env-vars="NODE_ENV=production,SHEETS_SERVICE_PORT=5050,GCS_BUCKET=dj-newsroom-stag-shared,GCS_PREFIX=jon_leckie"

echo "==> Done! Service URL:"
gcloud run services describe "${SERVICE_NAME}" --region="${REGION}" --project="${PROJECT_ID}" --format='value(status.url)'
