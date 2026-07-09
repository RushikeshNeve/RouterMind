export interface Logger {
  debug(data: Record<string, unknown>, message: string): void;
  info(data: Record<string, unknown>, message: string): void;
  warn(data: Record<string, unknown>, message: string): void;
  error(data: Record<string, unknown>, message: string): void;
}

export interface MetricRecorder {
  increment(name: string, attributes?: Record<string, string>): void;
  histogram(name: string, value: number, attributes?: Record<string, string>): void;
}

export interface TraceContext {
  readonly traceId: string;
  readonly spanId: string;
}

export interface SpanAttributes {
  readonly [key: string]: string | number | boolean | undefined;
}

export interface Span {
  setAttribute(name: string, value: string | number | boolean | undefined): void;
  recordException(error: unknown): void;
  end(attributes?: SpanAttributes): void;
}

export interface Tracer {
  startSpan(name: string, attributes?: SpanAttributes): Span;
  withSpan<T>(
    name: string,
    attributes: SpanAttributes,
    operation: (span: Span) => Promise<T>,
  ): Promise<T>;
}

export class NoopSpan implements Span {
  setAttribute(): void {
    // Intentionally empty; vendor integrations can implement this interface.
  }

  recordException(): void {
    // Intentionally empty; vendor integrations can implement this interface.
  }

  end(): void {
    // Intentionally empty; vendor integrations can implement this interface.
  }
}

export class NoopTracer implements Tracer {
  startSpan(name: string, attributes?: SpanAttributes): Span {
    void name;
    void attributes;
    return new NoopSpan();
  }

  async withSpan<T>(
    name: string,
    attributes: SpanAttributes,
    operation: (span: Span) => Promise<T>,
  ): Promise<T> {
    const span = this.startSpan(name, attributes);
    try {
      const result = await operation(span);
      span.end({ status: "ok" });
      return result;
    } catch (error) {
      span.recordException(error);
      span.end({ status: "error" });
      throw error;
    }
  }
}
