# Deploy the API that Softfactory generated (mongolbank-rates) to Cloud Run.
# Put this file in the root of the generated repo. Set APP_MODULE to the FastAPI app path
# the build produced (check with: grep -rn "FastAPI(" --include=*.py .).
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt uvicorn
COPY . .
ENV PORT=8080 APP_MODULE=app.main:app
CMD exec uvicorn ${APP_MODULE} --host 0.0.0.0 --port ${PORT}

# Deploy (from the generated repo root):
#   gcloud run deploy mongolbank-rates --source . --region asia-northeast1 --allow-unauthenticated
# The SQLite cache is local to each instance: run the backfill on start-up or use --min-instances 1.
