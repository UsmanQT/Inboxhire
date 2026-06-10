# Inboxhire

A personal job application tracker that automatically reads your Gmail, extracts company names and job titles using Claude AI, and displays everything in a clean dashboard — all running on Kubernetes.

---

## How It Works

```
Gmail → gmail-poller → parser → api → postgres
                                          ↑
                                      frontend
```

1. **gmail-poller** connects to your Gmail via OAuth and fetches job-related emails every 5 minutes
2. **parser** first tries regex pattern matching to extract company/job title for free, then falls back to Claude AI for tricky emails
3. **api** stores results in postgres and serves them via REST endpoints
4. **frontend** displays all applications in a dashboard with status dropdowns
5. **postgres** persists all application data with a PersistentVolumeClaim

---

## Services

| Service | Port | Type | Description |
|---|---|---|---|
| frontend | 30011 (NodePort) | nginx | Static HTML dashboard |
| api | 30010 (NodePort) | Express | REST API for applications |
| parser | 3001 (ClusterIP) | Express | Email parsing with Claude AI |
| db | 5432 (ClusterIP) | Postgres 13 | Database |
| gmail-poller | — | Worker | Gmail fetcher, no HTTP server |

---

## Prerequisites

- Docker Desktop with Kubernetes enabled (or any Kubernetes cluster)
- Docker Hub account
- [Anthropic API key](https://console.anthropic.com/)
- Gmail OAuth credentials (`credentials.json` and `token.json`)

---

## Setup

### 1. Clone the repo

```bash
git clone <your-repo-url>
cd job-tracker
```

### 2. Create your Kubernetes secret

Copy the example and fill in your base64-encoded values:

```bash
cp k8s/secret.yaml.example k8s/secret.yaml
```

Encode your values:

```bash
echo -n 'your-anthropic-api-key' | base64
echo -n 'your-db-password' | base64
```

Paste the output into `k8s/secret.yaml`.

### 3. Create the Gmail credentials secret

You need `credentials.json` (from Google Cloud Console) and `token.json` (generated after first OAuth login):

```bash
kubectl create secret generic gmail-credentials \
  --from-file=credentials.json=./credentials.json \
  --from-file=token.json=./token.json \
  -n inboxhire
```

### 4. Deploy to Kubernetes

Apply everything in order:

```bash
# Namespace first
kubectl apply -f k8s/namespace.yaml

# Config and secrets
kubectl apply -f k8s/configmap.yaml
kubectl apply -f k8s/secret.yaml

# Database
kubectl apply -f k8s/database/pvc.yaml
kubectl apply -f k8s/database/deployment.yaml
kubectl apply -f k8s/database/service.yaml

# Wait for DB to be ready
kubectl wait --for=condition=ready pod -l service=postgres -n inboxhire --timeout=60s

# Parser
kubectl apply -f k8s/parser/deployment.yaml
kubectl apply -f k8s/parser/service.yaml

# API
kubectl apply -f k8s/api/deployment.yaml
kubectl apply -f k8s/api/service.yaml

# Gmail poller
kubectl apply -f k8s/gmail-poller/deployment.yaml

# Frontend
kubectl apply -f k8s/frontend/deployment.yaml
kubectl apply -f k8s/frontend/service.yaml
```

### 5. Open the dashboard

```
http://localhost:30011
```

---

## Kubernetes Structure

```
k8s/
├── namespace.yaml
├── configmap.yaml
├── secret.yaml.example        # copy to secret.yaml and fill in values
├── api/
│   ├── deployment.yaml
│   └── service.yaml
├── database/
│   ├── deployment.yaml
│   ├── pvc.yaml
│   └── service.yaml
├── frontend/
│   ├── deployment.yaml
│   └── service.yaml
├── gmail-poller/
│   └── deployment.yaml
└── parser/
    ├── deployment.yaml
    └── service.yaml
```

---

## Useful Commands

```bash
# Check all pods
kubectl get pods -n inboxhire

# Watch logs
kubectl logs -n inboxhire -l app=gmail-poller --follow
kubectl logs -n inboxhire -l app=parser --follow
kubectl logs -n inboxhire -l app=api --follow

# Restart a deployment
kubectl rollout restart deployment/gmail-poller -n inboxhire

# Connect to the database
kubectl exec -it -n inboxhire deployment/postgres -- psql -U admin -d jobtracker

# Clear all data and re-poll
# 1. DELETE FROM applications; (inside psql)
# 2. kubectl rollout restart deployment/gmail-poller -n inboxhire
```

---

## Docker Images

All images are hosted on Docker Hub under `iusmanq/`:

- `iusmanq/inboxhire-api:v1`
- `iusmanq/inboxhire-parser:v1`
- `iusmanq/inboxhire-gmail-poller:v1`
- `iusmanq/inboxhire-frontend:v1`

---

## Branches

| Branch | Description |
|---|---|
| `main` | Base setup |
| `feature/docker-compose` | Full app running with Docker Compose |
| `feature/kubernetes` | Full app running on Kubernetes |

---

## Security Notes

- Never commit `k8s/secret.yaml` — it's in `.gitignore`
- Never commit `credentials.json` or `token.json` — Gmail OAuth files stay local
- If you accidentally expose an API key, rotate it immediately
- Gmail credentials are mounted into pods via Kubernetes secrets, not baked into Docker images
