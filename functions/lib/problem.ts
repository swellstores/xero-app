export type SwellRecord = Record<string, any>;

/** A reason not to create a document. `failed` needs the merchant; `skipped` is outside what the app does */
export class Problem extends Error {
  status: "failed" | "skipped";
  code: string;

  constructor(status: "failed" | "skipped", code: string, message: string) {
    super(message);
    this.name = "Problem";
    this.status = status;
    this.code = code;
  }
}
