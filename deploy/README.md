# Self-hosted deployment

The production application runs as `ai-task-board.service` on
`127.0.0.1:3200`. Caddy owns public ports 80/443, proxies the application, and
manages the certificate for `task.neilx.online`.

## Prerequisites

- `task.neilx.online` has an A record pointing to `124.156.194.176`.
- The cloud firewall allows inbound TCP 80 and 443. Do not expose port 3200.
- Local PostgreSQL is installed and reachable through
  `/var/run/postgresql`. The `ai-task-board` database has every migration
  applied, and the Unix socket + peer-auth role `ai-task-board` exists.
- `.env.local` is mode 0640, owned by the deployment user and readable only by
  the `ai-task-board` service group. It sets
  `NEXT_PUBLIC_APP_URL=https://task.neilx.online` plus `DATABASE_URL`,
  `AI_TOKEN_PEPPER`, `LOCAL_STORAGE_DIR` and `FILE_EXPLORER_ROOTS`.

## Build and install

```bash
sudo apt-get update
sudo apt-get install -y caddy postgresql postgresql-contrib
sudo -u postgres psql -c 'create role "ai-task-board" superuser'
sudo -u postgres createdb ai_task_board
DATABASE_URL='postgresql:///ai_task_board?host=/var/run/postgresql' npm run db:local
sudo install -d -o ai-task-board -g ai-task-board /var/lib/ai-task-board/storage
npm ci
npm run build
getent passwd ai-task-board >/dev/null || \
  sudo useradd --system --user-group --no-create-home --home-dir /nonexistent \
    --shell /usr/sbin/nologin ai-task-board
sudo usermod --append --groups ubuntu ai-task-board
sudo chgrp ai-task-board .env.local
sudo chmod 0640 .env.local
sudo install -o root -g ai-task-board -m 0640 .env.local /etc/ai-task-board.env
sudo install -m 0644 deploy/ai-task-board.service /etc/systemd/system/ai-task-board.service
sudo install -m 0644 deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl daemon-reload
sudo systemctl enable --now ai-task-board.service
sudo systemctl enable --now caddy.service
```

The file preview page (`/files`) reads server-local directories allowed by
`FILE_EXPLORER_ROOTS` (comma-separated). The systemd unit mounts
`/home/ubuntu` read-only for this purpose; if you change the configured
roots, add a matching `BindReadOnlyPaths=` entry to
`deploy/ai-task-board.service` and restart the service.

The application connects to the local PostgreSQL over the Unix socket using
peer authentication (the OS user `ai-task-board` maps to the same-named
superuser role), and stores attachments under
`/var/lib/ai-task-board/storage`. The unit mounts the socket directory
read-only and the storage directory read-write.

## Operations

```bash
sudo systemctl status ai-task-board caddy
sudo journalctl -u ai-task-board -u caddy --since today
sudo systemctl restart ai-task-board
sudo systemctl reload caddy
```

After code or any `NEXT_PUBLIC_` environment value changes, run
the following deployment sequence:

```bash
sudo systemctl stop ai-task-board
npm ci
npm run build
sudo install -o root -g ai-task-board -m 0640 .env.local /etc/ai-task-board.env
sudo systemctl start ai-task-board
```

Caddy obtains and renews the public certificate automatically once DNS resolves
and ports 80/443 are reachable.
