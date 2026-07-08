import { ProviderErrorClassifier, type ProviderErrorType } from "./provider-error-classifier.js";

export interface RetryPolicyConfig {
  readonly maxRetries: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export interface RetryAttemptFailure {
  readonly error: unknown;
  readonly errorType: ProviderErrorType;
  readonly attemptNumber: number;
  readonly willRetry: boolean;
}

export interface RetryPolicyResult<TValue> {
  readonly value?: TValue;
  readonly error?: unknown;
  readonly failures: readonly RetryAttemptFailure[];
}

export interface RetryPolicyHooks<TValue> {
  onSuccess?(input: { value: TValue; attemptNumber: number; latencyMs: number }): Promise<void>;
  onFailure?(input: RetryAttemptFailure & { latencyMs: number }): Promise<void>;
}

export class RetryPolicyService {
  constructor(
    private readonly classifier = new ProviderErrorClassifier(),
    private readonly config: RetryPolicyConfig = {
      maxRetries: 2,
      baseDelayMs: 300,
      maxDelayMs: 3000,
    },
    private readonly sleep: (delayMs: number) => Promise<void> = defaultSleep,
  ) {}

  async execute<TValue>(
    operation: (attemptNumber: number) => Promise<TValue>,
    hooks: RetryPolicyHooks<TValue> = {},
  ): Promise<RetryPolicyResult<TValue>> {
    const failures: RetryAttemptFailure[] = [];
    const maxAttempts = this.config.maxRetries + 1;

    for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber += 1) {
      const attemptStartedAt = Date.now();
      try {
        const value = await operation(attemptNumber);
        await hooks.onSuccess?.({
          value,
          attemptNumber,
          latencyMs: Date.now() - attemptStartedAt,
        });
        return {
          value,
          failures,
        };
      } catch (error) {
        const errorType = this.classifier.classify(error);
        const willRetry = attemptNumber < maxAttempts && this.classifier.isTransient(errorType);

        failures.push({
          error,
          errorType,
          attemptNumber,
          willRetry,
        });
        await hooks.onFailure?.({
          error,
          errorType,
          attemptNumber,
          willRetry,
          latencyMs: Date.now() - attemptStartedAt,
        });

        if (!willRetry) {
          return {
            error,
            failures,
          };
        }

        await this.sleep(this.calculateDelay(attemptNumber));
      }
    }

    return {
      error: failures[failures.length - 1]?.error,
      failures,
    };
  }

  private calculateDelay(attemptNumber: number): number {
    const exponentialDelay = this.config.baseDelayMs * 2 ** (attemptNumber - 1);
    const cappedDelay = Math.min(this.config.maxDelayMs, exponentialDelay);
    const jitter = Math.floor(Math.random() * this.config.baseDelayMs);

    return Math.min(this.config.maxDelayMs, cappedDelay + jitter);
  }
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
