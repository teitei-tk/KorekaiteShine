/* oxlint-disable import/unambiguous, typescript/consistent-type-imports -- ambient module宣言をmodule augmentationへ変更しない。 */
// oxlint-disable-next-line import/unambiguous -- プラットフォームが読み込むスクリプトまたはambient宣言であり、module化しない。
declare module 'cloudflare:workers' {
  export const env: import('./server/interview-runtime').Bindings;
}
