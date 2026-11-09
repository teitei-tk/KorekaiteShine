declare module 'cloudflare:workers' {
  export const env: import('./server/interview-runtime').Bindings;
}
