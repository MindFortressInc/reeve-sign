/**
 * DEV-654: the in-person handoff capability lives in sessionStorage -- scoped
 * to the one tab the host started the session in, and gone when that tab
 * closes. Storage can be unavailable (private mode, blocked site data), in
 * which case the handoff panel simply doesn't render.
 */
const storageKey = (documentId: number) => `reeve-sign:handoff-capability:${documentId}`;

export const saveHandoffCapability = (documentId: number, capability: string) => {
  try {
    window.sessionStorage.setItem(storageKey(documentId), capability);
  } catch {
    // Storage unavailable -- the chain stops after the first signer.
  }
};

export const readHandoffCapability = (documentId: number): string | null => {
  try {
    return window.sessionStorage.getItem(storageKey(documentId));
  } catch {
    return null;
  }
};

export const clearHandoffCapability = (documentId: number) => {
  try {
    window.sessionStorage.removeItem(storageKey(documentId));
  } catch {
    // Nothing to clear.
  }
};
