import type { VocabImportErrorCode } from "../../../contracts/src/index.ts";

export class VocabImportError extends Error {
  readonly code: VocabImportErrorCode;

  constructor(_code: VocabImportErrorCode, _message: string) {
    super("not implemented");
    throw new Error("not implemented");
  }
}
