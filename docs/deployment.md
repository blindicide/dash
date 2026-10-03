# Remote access and deployment

dash adds no network listener. It is reachable exactly where the Hermes Dashboard is
reachable, and inherits the Dashboard's authentication. These are the deployment rules that
matter for dash:

1. **Keep the Hermes API server on loopback** (`API_SERVER_HOST=127.0.0.1`). Only the
   Dashboard process talks to it.
2. **Expose the Dashboard, not the API server.** Prefer Tailscale or an SSH tunnel. If you
   publish it through a reverse proxy, the Dashboard's auth gate must be on.
3. **Do not buffer SSE.** dash streams run events over `GET /api/plugins/dash/runs/*/events`
   (`text/event-stream`). dash sets `X-Accel-Buffering: no` and
   `Cache-Control: no-cache, no-transform`; make sure your proxy honours them, does not
   compress the stream, and allows long-lived responses (runs can last many minutes;
   keepalive comments arrive about every 10 s).
4. **Use HTTPS** for anything that is not loopback.

## Dashboard authentication recap (Hermes v0.21.5)

- Bound to `127.0.0.1` with no public URL: loopback mode. The SPA receives a per-process
  session token and sends it as `X-Hermes-Session-Token`. Fine for SSH tunnels.
- A non-loopback bind, **or** `dashboard.public_url` set to a non-loopback host: the auth gate
  engages (cookie auth). An auth provider (bundled password `basic` provider or OAuth) is
  required, and the Dashboard refuses to start without one. `--insecure` no longer disables
  this.
- `dashboard.public_url` is also the exact trust declaration for the proxied `Host`/`Origin`.
  Set it to the URL users open, e.g. `https://hermes.example.com`.

dash's own mutation guard accepts a browser `Origin` only when it exactly matches the
request's `scheme://Host`. It intentionally ignores `X-Forwarded-Host` and
`X-Forwarded-Proto`, because those headers are safe only after a trusted-proxy boundary. If
TLS terminates at your proxy, add the exact public HTTPS origin (for example,
`https://hermes.example.com`) to `DASH_TRUSTED_ORIGINS` in the Dashboard's environment.
The forwarding headers shown below are still used by the Dashboard itself.

## Tailscale (recommended)

```bash
# Dashboard stays on loopback
hermes dashboard --host 127.0.0.1 --port 9119

# Publish it on your tailnet with HTTPS
tailscale serve --bg --https=443 http://127.0.0.1:9119
```

```yaml
# ~/.hermes/config.yaml — the ts.net name becomes a trusted public host (gate engages)
dashboard:
  public_url: https://<machine>.<tailnet>.ts.net
  basic_auth:
    username: you
    password_hash: <hash>
```

Generate the hash with Hermes' bundled provider (run it with the Hermes runtime, e.g. from
`~/.hermes/hermes-agent`): `python -c "from plugins.dashboard_auth.basic import hash_password; print(hash_password('your-password'))"`.
Alternatively, use OAuth with `hermes dashboard register`.

Tailscale Serve does not buffer SSE. Do **not** use `tailscale funnel` unless you mean to
publish to the internet.

## SSH tunnel (simplest)

```bash
ssh -N -L 9119:127.0.0.1:9119 you@server
# open http://127.0.0.1:9119/dash locally — stays in loopback mode
```

## Caddy

```caddy
hermes.example.com {
	encode {
		# never compress the SSE stream
		match {
			not header Content-Type text/event-stream*
		}
		gzip
	}
	reverse_proxy 127.0.0.1:9119 {
		flush_interval -1          # stream immediately (SSE)
		transport http {
			read_timeout 0
		}
	}
}
```

## nginx

```nginx
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

server {
    listen 443 ssl http2;
    server_name hermes.example.com;
    # ssl_certificate …; ssl_certificate_key …;

    location / {
        proxy_pass http://127.0.0.1:9119;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        # Dashboard WebSockets (embedded chat/PTY)
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        # SSE: no buffering, no gzip, long reads
        proxy_buffering off;
        proxy_cache off;
        gzip off;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }
}
```

dash also sends `X-Accel-Buffering: no`, which disables nginx buffering per response even
when `proxy_buffering` is left on elsewhere.

## Traefik (v3, file provider)

```yaml
http:
  routers:
    hermes:
      rule: Host(`hermes.example.com`)
      entryPoints: [websecure]
      service: hermes
      tls: {}
  services:
    hermes:
      loadBalancer:
        servers:
          - url: http://127.0.0.1:9119
        responseForwarding:
          flushInterval: 100ms     # SSE-friendly; Traefik also flushes text/event-stream immediately
```

Do not attach a `compress` middleware to this router (or exclude `text/event-stream`).
Traefik's default `respondingTimeouts.readTimeout` applies to request bodies, not to the
streamed response. If you set `writeTimeout`, keep it above your longest run.

## Path prefix

The Dashboard supports `X-Forwarded-Prefix` (e.g. serving under `/hermes`). dash uses only
relative `/api/plugins/dash/*` URLs through the plugin SDK, which applies the Dashboard's base
path, so prefixes work without configuration.

## Checklist

- [ ] `curl -s http://127.0.0.1:8642/health` works on the server; port 8642 is **not**
      reachable from other machines.
- [ ] Opening `https://…/dash` asks for Dashboard login when remote.
- [ ] Sending a message streams text token by token (not all at once at the end; if it
      arrives all at once, the proxy is buffering).
- [ ] Reloading during a long answer re-attaches to the same run.
