import type { VocabImportErrorCode } from "../../../contracts/src/index.ts";

export class VocabImportError extends Error {
  readonly code: VocabImportErrorCode;

  constructor(code: VocabImportErrorCode, message: string) {
    super(message);
    this.name = "VocabImportError";
    this.code = code;
  }
}
