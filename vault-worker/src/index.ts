/**
 * Minimal Cloudflare Worker for evalkit Private Vault intake.
 *
 * Accepts:
 *  - POST /submit (application/json): Blind Scorecard (`{ card }`) waitlist/catalog intake
 *  - POST /submit (multipart/form-data): Blind Scorecard (`card`) + `.evalkit.tar.gz` (`bundle`)
 *  - GET  /health: Service health check
 *
 * Deploy in 2 minutes:
 *   cd vault-worker && npx wrangler deploy
 */

interface Env {
  VAULT_BUCKET?: R2Bucket;
  VAULT_API_KEY?: string;
}

interface R2Bucket {
  put(key: string, value: string | ArrayBuffer | ReadableStream, options?: Record<string, unknown>): Promise<unknown>;
}

interface BlindCardPayload {
  id: string;
  bundle_sha256: string;
  stack: string[];
  verification?: { verified?: boolean };
  ownership?: { author_attestation?: boolean };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function validateCard(card: unknown): card is BlindCardPayload {
  if (!card || typeof card !== "object") return false;
  const c = card as Record<string, unknown>;
  return (
    typeof c.id === "string" &&
    c.id.length > 0 &&
    typeof c.bundle_sha256 === "string" &&
    c.bundle_sha256.length === 64 &&
    Array.isArray(c.stack) &&
    Boolean((c.ownership as Record<string, unknown> | undefined)?.author_attestation === true)
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({ ok: true, service: "evalkit-vault-intake", version: "0.3.0" });
    }

    if (request.method !== "POST" || url.pathname !== "/submit") {
      return jsonResponse({ error: "Use POST /submit" }, 404);
    }

    if (env.VAULT_API_KEY) {
      const auth = request.headers.get("Authorization") ?? "";
      if (auth !== `Bearer ${env.VAULT_API_KEY}`) {
        return jsonResponse({ error: "Unauthorized" }, 401);
      }
    }

    const contentType = request.headers.get("Content-Type") ?? "";
    const submissionId = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

    try {
      if (contentType.includes("multipart/form-data")) {
        const form = await request.formData();
        const rawCard = form.get("card");
        const bundleFile = form.get("bundle");
        if (typeof rawCard !== "string") {
          return jsonResponse({ error: "Missing card field" }, 400);
        }
        const card = JSON.parse(rawCard);
        if (!validateCard(card)) {
          return jsonResponse(
            { error: "Invalid card.json (requires id, 64-char bundle_sha256, stack[], and author_attestation: true)" },
            400
          );
        }

        if (env.VAULT_BUCKET) {
          await env.VAULT_BUCKET.put(
            `cards/${card.id}/${submissionId}.json`,
            JSON.stringify({ submissionId, receivedAt: new Date().toISOString(), card }, null, 2)
          );
          if (bundleFile && typeof bundleFile !== "string") {
            const bytes = await (bundleFile as Blob).arrayBuffer();
            await env.VAULT_BUCKET.put(`bundles/${card.id}/${submissionId}.evalkit.tar.gz`, bytes);
          }
        }

        return jsonResponse({
          accepted: true,
          submission_id: submissionId,
          mode: "full-bundle",
          task_id: card.id,
          bundle_sha256: card.bundle_sha256,
          stored_in_r2: Boolean(env.VAULT_BUCKET),
        });
      }

      const payload = (await request.json()) as { card?: unknown };
      if (!validateCard(payload.card)) {
        return jsonResponse(
          { error: "Invalid card payload (requires id, 64-char bundle_sha256, stack[], and author_attestation: true)" },
          400
        );
      }

      if (env.VAULT_BUCKET) {
        await env.VAULT_BUCKET.put(
          `cards/${payload.card.id}/${submissionId}.json`,
          JSON.stringify(
            { submissionId, receivedAt: new Date().toISOString(), card: payload.card },
            null,
            2
          )
        );
      }

      return jsonResponse({
        accepted: true,
        submission_id: submissionId,
        mode: "blind-card",
        task_id: payload.card.id,
        bundle_sha256: payload.card.bundle_sha256,
        stored_in_r2: Boolean(env.VAULT_BUCKET),
      });
    } catch (err) {
      return jsonResponse({ error: (err as Error).message || "Malformed submission" }, 400);
    }
  },
};
