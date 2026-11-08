/**
 * Test helper: a fake of Step Functions' SendTaskSuccess and SendTaskFailure. It keeps every
 * call, and can be told to fail the next SendTaskSuccess, as an expired token or a throttled
 * call would.
 */
import type { TaskTokens } from "@vocab/factory-orchestrator";

export class FakeTaskTokens implements TaskTokens {
  readonly successes: { taskToken: string; output: string }[] = [];
  readonly failures: { taskToken: string; error: string; cause: string }[] = [];
  /** Rejects the next SendTaskSuccess with this error, then clears it. */
  failNextSuccess: Error | undefined;

  succeed(taskToken: string, output: string): Promise<void> {
    const error = this.failNextSuccess;
    if (error !== undefined) {
      this.failNextSuccess = undefined;
      return Promise.reject(error);
    }
    this.successes.push({ taskToken, output });
    return Promise.resolve();
  }

  fail(taskToken: string, error: string, cause: string): Promise<void> {
    this.failures.push({ taskToken, error, cause });
    return Promise.resolve();
  }
}
