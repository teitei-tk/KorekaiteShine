export { InterviewObject } from './server/interview-object';
// HTTP公開はWeb Workerだけが担当する。DOには本人確認済みの内部bindingから到達する。
export default { fetch: async () => new Response(null, { status: 404 }) };
