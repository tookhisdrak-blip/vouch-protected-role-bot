// discord.js already queues 429 responses and waits for retry_after before retrying.
// This layer covers what still reaches our code (rate-limit rejections, 5xx after the
// library's own retries, timeouts, network resets) so enforcement is never dropped.

const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'
]);

const INLINE_ATTEMPTS = 4;
const INLINE_MAX_WAIT_MS = 15_000;
const BACKGROUND_ATTEMPTS = 8;
const BACKGROUND_MAX_WAIT_MS = 5 * 60_000;
const BASE_BACKOFF_MS = 1_000;

const defaultTiming = {
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  schedule: (callback, milliseconds) => {
    const timer = setTimeout(callback, milliseconds);
    timer.unref?.();
    return timer;
  },
  cancel: (timer) => clearTimeout(timer)
};
let timing = { ...defaultTiming };
const deferredTasks = new Map();

function configureRetryTiming(overrides = {}) {
  timing = { ...defaultTiming, ...overrides };
}

function retryAfterMs(error) {
  if (!error) return null;
  if (Number.isFinite(error.retryAfter)) return Math.max(0, error.retryAfter);
  if (Number.isFinite(error.timeToReset)) return Math.max(0, error.timeToReset);
  const raw = error.rawError?.retry_after;
  if (Number.isFinite(raw)) return Math.max(0, raw * 1000);
  const header = typeof error.headers?.get === 'function' ? error.headers.get('retry-after') : error.headers?.['retry-after'];
  if (header !== undefined && header !== null && Number.isFinite(Number(header))) return Math.max(0, Number(header) * 1000);
  return null;
}

function isRateLimitError(error) {
  if (!error) return false;
  return String(error.name || '').startsWith('RateLimitError')
    || error.status === 429
    || error.httpStatus === 429
    || retryAfterMs(error) !== null;
}

function isTransientDiscordError(error) {
  if (!error) return false;
  if (isRateLimitError(error)) return true;
  const status = error.status ?? error.httpStatus;
  if (Number.isInteger(status) && status >= 500) return true;
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return true;
  const code = error.code ?? error.cause?.code;
  return typeof code === 'string' && TRANSIENT_NETWORK_CODES.has(code);
}

function backoffDelay(error, attempt, maxWait) {
  const requested = retryAfterMs(error);
  // Small jitter keeps many queued retries from hitting Discord at the same instant.
  const jitter = Math.floor(Math.random() * 250);
  if (requested !== null) return requested + jitter;
  return Math.min(maxWait, BASE_BACKOFF_MS * 2 ** attempt) + jitter;
}

/**
 * Runs a Discord operation, retrying transient failures (rate limits honor retry_after).
 * Permanent errors (missing permissions, unknown member/role, ...) are thrown immediately.
 * Throws the last error with `error.transient = true` when retries are exhausted.
 */
async function withDiscordRetry(operation, options = {}) {
  const attempts = options.attempts ?? INLINE_ATTEMPTS;
  const maxWait = options.maxWaitMs ?? INLINE_MAX_WAIT_MS;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (!isTransientDiscordError(error)) throw error;
      const delay = backoffDelay(error, attempt, maxWait);
      if (attempt + 1 >= attempts || delay > maxWait + 250) {
        error.transient = true;
        error.retryAfterMs = delay;
        throw error;
      }
      console.warn(`${options.label || 'Discord request'} ${isRateLimitError(error) ? 'rate limited' : 'failed temporarily'}; retrying in ${delay}ms (${error.message || error.name})`);
      await timing.sleep(delay);
      if (options.shouldContinue && !(await options.shouldContinue())) return undefined;
    }
  }
}

/**
 * Keeps retrying an operation in the background after inline retries were exhausted.
 * `isStillRequired` is re-checked before every attempt so stale enforcement is never applied.
 * Only one task per key is kept; scheduling the same key again keeps the existing task.
 */
function scheduleDeferredRetry(key, operation, options = {}) {
  if (deferredTasks.has(key)) return false;
  const task = { attempt: 0, timer: null };
  deferredTasks.set(key, task);
  const settle = async (outcome, error = null) => {
    deferredTasks.delete(key);
    try {
      if (outcome === 'completed') await options.onSuccess?.();
      if (outcome === 'failed') await options.onFailure?.(error);
    } finally {
      await options.onSettled?.(outcome);
    }
  };
  const run = async () => {
    task.timer = null;
    try {
      if (options.isStillRequired && !(await options.isStillRequired())) {
        return settle('skipped').catch((settleError) => console.error('Deferred retry cleanup failed:', settleError.message));
      }
      await operation();
    } catch (error) {
      task.attempt += 1;
      if (isTransientDiscordError(error) && task.attempt < (options.attempts ?? BACKGROUND_ATTEMPTS)) {
        task.timer = timing.schedule(run, backoffDelay(error, task.attempt + 2, BACKGROUND_MAX_WAIT_MS));
        return undefined;
      }
      console.error(`${options.label || 'Deferred Discord request'} could not be completed:`, error.message || error.name);
      return settle('failed', error).catch((settleError) => console.error('Deferred retry cleanup failed:', settleError.message));
    }
    return settle('completed').catch((settleError) => console.error('Deferred retry cleanup failed:', settleError.message));
  };
  task.timer = timing.schedule(run, Math.max(0, options.initialDelayMs ?? 0));
  return true;
}

function hasDeferredRetry(key) {
  return deferredTasks.has(key);
}

function clearDeferredRetries() {
  for (const task of deferredTasks.values()) if (task.timer) timing.cancel(task.timer);
  deferredTasks.clear();
}

module.exports = {
  withDiscordRetry,
  scheduleDeferredRetry,
  hasDeferredRetry,
  clearDeferredRetries,
  configureRetryTiming,
  isTransientDiscordError,
  isRateLimitError,
  retryAfterMs
};
