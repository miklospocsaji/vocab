/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The API's origin, such as `https://api.test.vocab.logtion.app`, set at build time. */
  readonly VITE_API_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
