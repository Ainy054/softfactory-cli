#!/usr/bin/env bash
# One-time + repeatable deploy of Softfactory to Google Cloud / Firebase.
# Usage:  PROJECT=my-gcp-project ./deploy.sh
set -euo pipefail
PROJECT=${PROJECT:-softfactory-490f2}
REGION=${REGION:-asia-northeast1}          # Tokyo, closest Cloud Run region to Mongolia
BUCKET=${PROJECT}-softfactory
SA=softfactory@${PROJECT}.iam.gserviceaccount.com

gcloud config set project "$PROJECT"

# 1. APIs
gcloud services enable run.googleapis.com firestore.googleapis.com aiplatform.googleapis.com \
  cloudbuild.googleapis.com artifactregistry.googleapis.com storage.googleapis.com \
  firebase.googleapis.com identitytoolkit.googleapis.com

# 2. Firestore (native mode) + bucket + service account (idempotent)
gcloud firestore databases create --location="$REGION" 2>/dev/null || true
gcloud storage buckets create "gs://$BUCKET" --location="$REGION" 2>/dev/null || true
gcloud iam service-accounts create softfactory --display-name="Softfactory runtime" 2>/dev/null || true
for ROLE in roles/datastore.user roles/storage.objectAdmin roles/aiplatform.user; do
  gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$SA" --role="$ROLE" --condition=None >/dev/null
done

# 3. Factory service (FastAPI + softfactory-cli) on Cloud Run
#    first copy your built softfactory-cli folder into orchestrator/softfactory-cli (see Dockerfile)
gcloud run deploy softfactory-api --source orchestrator --region "$REGION" \
  --service-account "$SA" --memory 4Gi --cpu 2 --no-cpu-throttling --timeout 3600 \
  --min-instances 1 --allow-unauthenticated \
  --set-env-vars "GOOGLE_CLOUD_PROJECT=$PROJECT,ARTIFACT_BUCKET=$BUCKET"

# 4. Firebase Hosting (console) + Firestore rules
#    first time: npm i -g firebase-tools && firebase login && firebase projects:addfirebase "$PROJECT"
#    then enable Google sign-in in Firebase console > Authentication, and paste the web config into web/public/index.html
(cd web && cp firebase.with-cloudrun.json firebase.json && firebase deploy --project "$PROJECT" --only hosting,firestore:rules)

# 5. The generated API itself (from the generated repo, see generated-app/Dockerfile):
#    gcloud run deploy mongolbank-rates --source <generated-repo> --region "$REGION" --allow-unauthenticated

echo "Console: https://${PROJECT}.web.app   API health: https://${PROJECT}.web.app/api/healthz"
