const MAX_ADMISSION_ATTEMPTS = 3;
const ADMISSION_RETRY_BACKOFF_MS = 25;

/** Retry an exhausted, confirmed-contention admission with its original request ID. */
export async function submitWithAdmissionRetry<T>(submit: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { return await submit(); }
    catch (error) {
      const retryable = error && typeof error === 'object'
        && (error as { code?: unknown }).code === 'storage_error'
        && (error as { writeError?: unknown }).writeError === 'storage_error'
        && (error as { retryableAdmissionContention?: unknown }).retryableAdmissionContention === true;
      if (!retryable || attempt >= MAX_ADMISSION_ATTEMPTS) throw error;
      await Bun.sleep(ADMISSION_RETRY_BACKOFF_MS);
    }
  }
}
