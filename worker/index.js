// 密钥通过 Cloudflare Worker 环境变量注入
// GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, FRONTEND_URL

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const REDIRECT_URI = 'https://image-bg-remover-api.tyongjian88.workers.dev/auth/callback';
    const FRONTEND_URL = env.FRONTEND_URL || 'https://image-background-remover.quest/static.html';

    function corsHeaders() {
      return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      };
    }

    function json(data, status = 200) {
      return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      });
    }

    function getSession(request) {
      try {
        const auth = request.headers.get('Authorization');
        if (!auth) return null;
        const session = JSON.parse(atob(auth.replace('Bearer ', '')));
        if (session.exp < Date.now()) return null;
        return session;
      } catch {
        return null;
      }
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    // ── Google OAuth 登录入口 ──
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

    // ── OAuth 回调（独立路径）──
    if (url.pathname === '/auth/callback') {
      const code = url.searchParams.get('code');

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

      // 插入或更新用户
      await env.DB.prepare(`
        INSERT INTO users (google_id, email, name, avatar, last_login)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(google_id) DO UPDATE SET
          name = excluded.name,
          avatar = excluded.avatar,
          last_login = CURRENT_TIMESTAMP
      `).bind(user.id, user.email, user.name, user.picture).run();

      // 新用户赠送 3 次积分
      await env.DB.prepare(`
        INSERT INTO user_credits (google_id, credits)
        VALUES (?, 3)
        ON CONFLICT(google_id) DO NOTHING
      `).bind(user.id).run();

      const sessionData = btoa(JSON.stringify({
        id: user.id,
        email: user.email,
        name: user.name,
        avatar: user.picture,
        exp: Date.now() + 7 * 24 * 60 * 60 * 1000,
      }));

      return Response.redirect(`${FRONTEND_URL}?session=${sessionData}`, 302);
    }

    // ── 获取当前用户信息 + 积分 ──
    if (url.pathname === '/auth/me') {
      const session = getSession(request);
      if (!session) return json({ error: 'Unauthorized' }, 401);

      const dbUser = await env.DB.prepare('SELECT * FROM users WHERE google_id = ?').bind(session.id).first();
      const credits = await env.DB.prepare('SELECT credits FROM user_credits WHERE google_id = ?').bind(session.id).first();

      return json({ user: dbUser, credits: credits?.credits ?? 0 });
    }

    // ── 查询积分 ──
    if (url.pathname === '/credits') {
      const session = getSession(request);
      if (!session) return json({ error: 'Unauthorized' }, 401);

      const row = await env.DB.prepare('SELECT credits FROM user_credits WHERE google_id = ?').bind(session.id).first();
      return json({ credits: row?.credits ?? 0 });
    }

    // ── 消耗积分（抠图前调用）──
    if (url.pathname === '/credits/consume' && request.method === 'POST') {
      const session = getSession(request);
      if (!session) return json({ error: 'Unauthorized', code: 401 }, 401);

      const row = await env.DB.prepare('SELECT credits FROM user_credits WHERE google_id = ?').bind(session.id).first();
      const current = row?.credits ?? 0;

      if (current <= 0) return json({ error: 'No credits', code: 402 }, 402);

      await env.DB.prepare(`
        UPDATE user_credits SET credits = credits - 1, updated_at = CURRENT_TIMESTAMP
        WHERE google_id = ?
      `).bind(session.id).run();

      return json({ success: true, remaining: current - 1 });
    }

    // ── 支付校验：创建订单 ──
    if (url.pathname === '/paypal/create' && request.method === 'POST') {
      const { plan } = await request.json();
      const plans = {
        'p10': { price: '4.99', credits: 10 },
        'p30': { price: '12.99', credits: 30 },
        'p80': { price: '29.99', credits: 80 }
      };
      if (!plans[plan]) return json({ error: 'Invalid plan' }, 400);

      // 获取 PayPal Access Token
      const auth = btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_SECRET}`);
      const tokenRes = await fetch('https://api-m.sandbox.paypal.com/v1/oauth2/token', {
        method: 'POST',
        headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials'
      });
      const tokenData = await tokenRes.json();
      if (!tokenData.access_token) return json({ error: 'PayPal Auth Failed', debug: tokenData }, 400);
      const { access_token } = tokenData;

      // 创建订单
      const orderRes = await fetch('https://api-m.sandbox.paypal.com/v2/checkout/orders', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          intent: 'CAPTURE',
          purchase_units: [{ amount: { currency_code: 'USD', value: plans[plan].price } }],
          application_context: {
            return_url: `https://image-background-remover.quest/pricing.html?capture=1&plan=${plan}`,
            cancel_url: 'https://image-background-remover.quest/pricing.html?cancel=1',
            brand_name: 'AI 抠图工具',
            user_action: 'PAY_NOW'
          }
        })
      });
      return json(await orderRes.json());
    }

    // ── 支付校验：完成支付并加分 ──
    if (url.pathname === '/paypal/capture' && request.method === 'POST') {
      const { orderID, plan } = await request.json();
      const plans = { 'p10': 10, 'p30': 30, 'p80': 80 };
      const session = getSession(request);
      if (!session) return json({ error: 'Unauthorized' }, 401);

      const auth = btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_SECRET}`);
      const tokenRes = await fetch('https://api-m.sandbox.paypal.com/v1/oauth2/token', {
        method: 'POST',
        headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials'
      });
      const { access_token } = await tokenRes.json();

      const capRes = await fetch(`https://api-m.sandbox.paypal.com/v2/checkout/orders/${orderID}/capture`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' }
      });
      const capData = await capRes.json();

      if (capData.status === 'COMPLETED') {
        await env.DB.prepare('UPDATE user_credits SET credits = credits + ? WHERE google_id = ?')
          .bind(plans[plan], session.id).run();
        return json({ success: true });
      }
      return json({ error: 'Payment capture failed' }, 400);
    }


    return new Response('Not Found', { status: 404 });
  }
};
