# evalkit Private Vault Worker

Minimal Cloudflare Worker intake endpoint for `evalkit submit --endpoint https://<your-worker>/submit`.

## Deploy

```bash
cd vault-worker
npx wrangler r2 bucket create evalkit-vault
# Uncomment the [[r2_buckets]] block in wrangler.toml, then:
npx wrangler secret put VAULT_API_KEY   # optional bearer auth
npx wrangler deploy
```

## Submit from CLI

```bash
# Blind scorecard only (zero source code leaves the dev's machine):
evalkit submit ./evals/my-bug --endpoint https://<your-worker>/submit

# Or upload the full packed `.evalkit.tar.gz` bundle to private R2:
evalkit submit ./evals/my-bug --endpoint https://<your-worker>/submit --full-bundle
```
