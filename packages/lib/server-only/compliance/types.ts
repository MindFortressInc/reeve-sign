/**
 * Wire (snake_case) and parsed (camelCase) types for the reeve-services
 * Reeve.Compliance API, mirrored from `api/schemas/compliance.py` at
 * reeve-services pin `31b880bc5526`.
 */

export type RawConsentStatusItem = {
  doc_type: string;
  accepted_version: string | null;
  accepted_at: string | null;
  current_version: string | null;
  needs_acceptance: boolean;
};

export type RawConsentStatusResponse = {
  status: RawConsentStatusItem[];
};

export type ConsentStatusItem = {
  docType: string;
  acceptedVersion: string | null;
  acceptedAt: string | null;
  currentVersion: string | null;
  needsAcceptance: boolean;
};

export type RawCurrentDocument = {
  doc_type: string;
  version: string;
  locale: string;
  effective_at: string | null;
  content_url: string | null;
  content_sha256: string | null;
};

export type RawCurrentDocumentsResponse = {
  documents: RawCurrentDocument[];
};

export type CurrentLegalDocument = {
  docType: string;
  version: string;
  locale: string;
  effectiveAt: string | null;
  contentUrl: string | null;
  contentSha256: string | null;
};

export type RawConsentRecordResponse = {
  id: string;
  host_app: string;
  subject_type: string;
  subject_id: string;
  doc_type: string;
  version: string;
  document_id: string | null;
  action: string;
  accepted_at: string | null;
  source: string | null;
};

export const mapConsentStatusItem = (raw: RawConsentStatusItem): ConsentStatusItem => ({
  docType: raw.doc_type,
  acceptedVersion: raw.accepted_version,
  acceptedAt: raw.accepted_at,
  currentVersion: raw.current_version,
  needsAcceptance: raw.needs_acceptance,
});

export const mapCurrentDocument = (raw: RawCurrentDocument): CurrentLegalDocument => ({
  docType: raw.doc_type,
  version: raw.version,
  locale: raw.locale,
  effectiveAt: raw.effective_at,
  contentUrl: raw.content_url,
  contentSha256: raw.content_sha256,
});
