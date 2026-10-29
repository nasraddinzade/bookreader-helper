// Ошибки провайдеров, по которым очередь решает, что делать дальше.

export class ProviderError extends Error {
  constructor(message, { kind = 'error', retryable = true, resumeAt = null, reduceBatch = false } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind; // error | limit | auth | unavailable
    this.retryable = retryable;
    this.resumeAt = resumeAt; // ms epoch, когда снимется лимит
    this.reduceBatch = reduceBatch; // ответ обрезан или сломан — пачку надо уменьшить
  }
}

/** Лимит подписки: очередь встаёт на паузу до resumeAt и продолжает сама. */
export const limitError = (message, resumeAt) => new ProviderError(message, { kind: 'limit', retryable: false, resumeAt });
/** Нет входа или провайдер недоступен: очередь ждёт действия пользователя, периодически проверяя. */
export const authError = (message) => new ProviderError(message, { kind: 'auth', retryable: false });
export const unavailableError = (message) => new ProviderError(message, { kind: 'unavailable', retryable: false });
