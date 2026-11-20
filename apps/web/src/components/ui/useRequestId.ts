import { useCallback, useState } from 'react';

/**
 * The id the next record saved from this form will have. Pressing Save twice
 * sends the same id, so the store returns the saved record instead of making
 * a second one. Call `next()` after a save that worked, so the form's next
 * entry gets a new id.
 */
export function useRequestId(): [string, () => void] {
  const [id, setId] = useState(() => crypto.randomUUID());
  const next = useCallback(() => setId(crypto.randomUUID()), []);
  return [id, next];
}
