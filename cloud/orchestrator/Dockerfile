# Softfactory factory service: FastAPI wrapper + softfactory-cli (Node) on Cloud Run
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git python3 python3-pip python3-venv ca-certificates curl lsof \
    && rm -rf /var/lib/apt/lists/*
RUN git config --global user.email "factory@asla.mn" && git config --global user.name "asla softfactory"
WORKDIR /srv
# 1) the CLI: deploy.sh copies the built CLI (package*.json + dist/) here as ./softfactory-cli
COPY softfactory-cli /opt/softfactory-cli
RUN cd /opt/softfactory-cli && npm ci --omit=dev && npm link
# 2) the API, plus the Python test stack generated projects usually need: Cloud Run has
#    no Docker, so softfactory verifies with the container's own pytest (--sandbox=none).
#    Installing into the image's system Python is fine here: the container is disposable.
COPY requirements.txt .
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt \
    uv pytest pytest-asyncio httpx respx requests beautifulsoup4 lxml sqlalchemy
COPY *.py ./orchestrator/
ENV PORT=8080 SOFTFACTORY_BIN=softfactory
CMD exec uvicorn orchestrator.main:app --host 0.0.0.0 --port ${PORT}
