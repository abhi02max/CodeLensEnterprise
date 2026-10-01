// Explicit test-only preload mounted into the C1 isolation project, never copied into images.
const nativeFetch = global.fetch;
const profiles = new Map();
global.fetch = async (input, options = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url || String(input));
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return nativeFetch(input, options);
  const headers = new Headers(options.headers || input.headers);
  if (url.origin === 'https://github.com' && url.pathname === '/login/oauth/access_token') {
    const code = JSON.parse(options.body).code;
    const kind = String(code).includes('unverified') ? 'unverified' : String(code).includes('existing') ? 'existing' : 'new';
    const token = `C1_SYNTHETIC_${kind}_TOKEN_MARKER`;
    profiles.set(token, kind);
    return Response.json({ access_token: token, scope: 'user:email', token_type: 'bearer' });
  }
  if (url.origin === 'https://api.github.com') {
    const kind = profiles.get((headers.get('authorization') || '').replace(/^token |^Bearer /i, ''));
    if (!kind) return Response.json({ message: 'C1_GITHUB_BODY_MARKER' }, { status: 401 });
    const id = kind === 'new' ? 901 : kind === 'existing' ? 902 : 903;
    const email = kind === 'new' ? 'new-c1@example.invalid' : 'owner-c1@example.invalid';
    if (url.pathname === '/user') return Response.json({ id, login: `c1-${kind}`, name: 'C1 Synthetic', email, avatar_url: '' });
    if (url.pathname === '/user/emails') return Response.json([{ email, primary: true, verified: kind !== 'unverified' }]);
  }
  if (url.origin === 'https://api.openai.com' || url.origin === 'https://api.anthropic.com') {
    return Response.json({ error: { message: 'C1_PROVIDER_BODY_MARKER', code: 'C1_PROVIDER_CODE_MARKER' } }, { status: 401 });
  }
  throw new Error('C1 external request blocked');
};
