// 密钥通过 Cloudflare Worker 环境变量注入，不硬编码在代码里
// 在 Cloudflare Dashboard 或 API 中设置：
// GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, FRONTEND_URL

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const REDIRECT_URI = 'https://image-background-remover.quest/callback';
    const FRONTEND_URL = env.FRONTEND_URL || 'https://image-background-remover.quest/static.html';

    function corsHeaders() {
      return {
        'Access-Control-Allow-Origin': FRONTEND_URL.replace('/static.html', ''),
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      };
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    // Google OAuth 登录入口
    if (url.pathname === '/auth/login') {
      const params = new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        scope: 'openid email profile',
        access_type: 'offline',
      });
      return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`, 302);
    }

    // OAuth 回调
    if (url.pathname === '/callback') {
      const code = url.searchParams.get('code');
      if (!code) return Response.redirect(FRONTEND_URL + '?error=no_code', 302);

      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET,
          redirect_uri: REDIRECT_URI,
          grant_type: 'authorization_code',
        }),
      });

      const tokenData = await tokenRes.json();
      if (!tokenData.access_token) return Response.redirect(FRONTEND_URL + '?error=token_failed', 302);

      const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const user = await userRes.json();

      await env.DB.prepare(`
        INSERT INTO users (google_id, email, name, avatar, last_login)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(google_id) DO UPDATE SET
          name = excluded.name,
          avatar = excluded.avatar,
          last_login = CURRENT_TIMESTAMP
      `).bind(user.id, user.email, user.name, user.picture).run();

      const sessionData = btoa(JSON.stringify({
        id: user.id,
        email: user.email,
        name: user.name,
        avatar: user.picture,
        exp: Date.now() + 7 * 24 * 60 * 60 * 1000,
      }));

      return Response.redirect(`${FRONTEND_URL}?session=${sessionData}`, 302);
    }

    // 获取当前用户信息
    if (url.pathname === '/auth/me') {
      const auth = request.headers.get('Authorization');
      if (!auth) return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders() }
      });
      try {
        const session = JSON.parse(atob(auth.replace('Bearer ', '')));
        if (session.exp < Date.now()) return new Response(JSON.stringify({ error: 'Session expired' }), {
          status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders() }
        });
        const dbUser = await env.DB.prepare('SELECT * FROM users WHERE google_id = ?').bind(session.id).first();
        return new Response(JSON.stringify({ user: dbUser }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders() }
        });
      } catch {
        return new Response(JSON.stringify({ error: 'Invalid session' }), {
          status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders() }
        });
      }
    }

    if (url.pathname === '/auth/logout') {
      return Response.redirect(FRONTEND_URL, 302);
    }

    return new Response('Not Found', { status: 404 });
  }
};
