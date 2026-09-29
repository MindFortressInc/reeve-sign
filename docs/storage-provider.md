# Storage provider

## Which store prod uses

Production stores uploads in **Cloudflare R2**, using R2's S3-compatible API.

| Setting | Prod value |
| --- | --- |
| `NEXT_PUBLIC_UPLOAD_TRANSPORT` | `s3` |
| `NEXT_PRIVATE_UPLOAD_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` |
| `NEXT_PRIVATE_UPLOAD_REGION` | `auto` |
| `NEXT_PRIVATE_UPLOAD_FORCE_PATH_STYLE` | `true` |
| `NEXT_PRIVATE_UPLOAD_BUCKET` | `reeve-sign-envelopes` |

`deploy/compose.yml` only passes these names through. The values live in the box's `.env`. The bucket was set up by DEV-637 (2026-05-13). On 2026-09-28 the running container's env was read to confirm the endpoint host is `*.r2.cloudflarestorage.com`.

Local dev and CI use MinIO. Its config is in `docker/development/compose.yml`.

## Size ceiling for recipient file uploads (DEV-12064)

A FILE_UPLOAD field enforces its 15MB limit (`FIELD_FILE_UPLOAD_SIZE_LIMIT_MB`) at two points.

1. **Presign, before any bytes are stored.** `presignEnvelopeFieldFileUploadRoute` rejects a declared `fileSize` over the limit. It then calls `getPresignPostUrlForKey(key, contentType, fileSize)`, which puts `content-length` into `X-Amz-SignedHeaders`. When a PUT's length differs from the signed length, the store rejects the signature before it writes anything. The URL expires after 10 minutes.
2. **Finalize, as a second check.** `finalizeFieldFileUpload` reads the real stored size with HeadObject and re-checks it against the limit and the claimed size. When the object fails a check, finalize tries to delete the tmp object. The delete is best-effort and is skipped if HeadObject or the copy itself errors.

Presigned POST with a `content-length-range` policy is **not an option on R2**. Cloudflare documents that "`POST` (multipart form uploads via HTML forms) is not currently supported" (<https://developers.cloudflare.com/r2/api/s3/presigned-urls/>).

### Measured R2 behaviour

Cloudflare's docs do not say whether R2 enforces a signed `Content-Length`, so it was measured. The probe ran on 2026-09-28 against a throwaway bucket, `reeve-sign-sizeprobe-20260928`, which was deleted afterwards. Each case used a URL from the real `getPresignPostUrlForKey`, signed for 4096 bytes (`X-Amz-SignedHeaders=content-length;host`). The requests were raw HTTP/1.1 over TLS.

| Case | R2 response | Stored |
| --- | --- | --- |
| 4096-byte body, `Content-Length: 4096` | `200 OK` | 4096 bytes |
| 5096-byte body, `Content-Length: 5096` | `403 SignatureDoesNotMatch` | nothing |
| `Content-Length: 4096` sent, 5096 bytes written | `200 OK` | 4096 bytes (trailing bytes discarded) |
| `Transfer-Encoding: chunked`, no `Content-Length`, 5096 bytes | `403 SignatureDoesNotMatch` | nothing |

Under every framing, R2 stores at most the signed length. MinIO behaves the same way, except that a chunked PUT gets `411 Length Required`. `finalize-field-file-upload.integration.test.ts` covers this against MinIO.

### What stays unbounded

A presigned URL can be replayed until it expires. Each replay is still capped at the signed size and overwrites the same tmp key. A recipient can mint new URLs, up to the global tRPC limit of 100 requests/min per IP (`apiTrpcRateLimit`). Nothing caps the total tmp-key storage per recipient. No job in this repo deletes tmp objects that are never finalized. If an R2 lifecycle rule exists on the bucket, it is not tracked here. DEV-12800 tracks adding an expiry for `field-uploads-tmp/`.
