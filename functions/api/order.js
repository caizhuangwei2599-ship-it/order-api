// ============ 全局常量 ============
const PHONE_TTL_MS = 180 * 1000;

async function fetchWithTimeout(url, options = {}, timeout = 4000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return response;
  } catch (error) {
    clearTimeout(id);
    throw new Error('接码平台请求超时或被中断');
  }
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      }
    });
  }

  const action = url.searchParams.get('action');
  const oid = url.searchParams.get('oid');

  try {
    const db = env.order_db; // 我们的核心：全部走 D1
    if (!db) throw new Error('严重错误：后端 D1 数据库 (order_db) 未绑定');

    // ====== D1 通用配置读写函数（替代 KV） ======
    async function getSetting(key) {
      const res = await db.prepare(`SELECT value FROM settings WHERE key=?`).bind(key).first();
      return res ? JSON.parse(res.value) : null;
    }
    async function setSetting(key, val) {
      await db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).bind(key, JSON.stringify(val)).run();
    }

    const POOL_KEY = 'phone_pool';
    const CARD_KEY = 'card_keys';

    const apiCfg = await getSetting('__api_config__') || {};
    const apiUser = apiCfg.user || '';
    const apiPass = apiCfg.pass || '';
    const sid = url.searchParams.get('sid') || apiCfg.sid || '24085';

    const poolActions = [
      'addPhone', 'removePhone', 'poolList', 'resetPool', 'releasePoolPhone', 'logList',
      'getBalance', 'lockOrder', 'blockPhone', 'generateCard', 'activateCard', 'verifyCard', 
      'cardList', 'deleteCard', 'createOrder', 'listActiveOrders', 'listAllOrders', 
      'releaseAllOrders', 'cancelRecvPhone', 'saveApiConfig', 'getApiConfig'
    ];
    if (!oid && !poolActions.includes(action)) {
      return jsonResponse({ error: '缺少订单ID' }, 400);
    }

    const HAOZHU = { server: 'api.haozhuma.com', user: apiUser, pass: apiPass, sid };

    async function getPool() { return (await getSetting(POOL_KEY)) || []; }
    async function savePool(pool) { await setSetting(POOL_KEY, pool); }
    async function getCards() { return (await getSetting(CARD_KEY)) || []; }
    async function saveCards(cards) { await setSetting(CARD_KEY, cards); }

    async function addLog(phone, oid, action) {
      await db.prepare(`INSERT INTO logs (phone, oid, action, time) VALUES (?, ?, ?, ?)`)
        .bind(phone, oid, action, Date.now()).run();
    }

    function generateCardKey() {
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      const segment = () => {
        let s = '';
        for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
        return s;
      };
      return `HZ-${segment()}-${segment()}`;
    }

    async function getValidToken() {
      if (!HAOZHU.user || !HAOZHU.pass) throw new Error('未配置接码平台账号密码');
      const tokenData = await getSetting('__token_data__');
      let tokenStr = tokenData ? tokenData.token : null;
      let tokenExpiry = tokenData ? tokenData.expire : 0;
      const needLogin = !tokenStr || Date.now() >= tokenExpiry - 300000;

      if (needLogin) {
        const loginResp = await fetchWithTimeout(`https://${HAOZHU.server}/sms/?api=login&user=${HAOZHU.user}&pass=${HAOZHU.pass}`);
        const loginData = await loginResp.json();
        if (loginData.code == 0) {
          tokenStr = loginData.token || loginData.Token || loginData.access_token;
          tokenExpiry = Date.now() + 3500000;
          await setSetting('__token_data__', { token: tokenStr, expire: tokenExpiry, apiUser: HAOZHU.user, apiPass: HAOZHU.pass });
        } else {
          throw new Error('接码平台登录失败：' + (loginData.msg || ''));
        }
      }
      return tokenStr;
    }

    async function releaseOrderPhone(order, oid) {
      if (!order || !order.phone) return;
      if (order.from_pool) {
        const pool = await getPool();
        const entry = pool.find(p => p.phone === order.phone);
        if (entry && entry.status === 'in_use') {
          entry.status = 'available'; entry.oid = null; entry.expire = null;
          await savePool(pool);
        }
      } else {
        try {
          const tokenStr = await getValidToken();
          const orderSid = order.sid || HAOZHU.sid;
          await fetchWithTimeout(`https://${HAOZHU.server}/sms/?api=cancelRecv&token=${tokenStr}&sid=${orderSid}&phone=${order.phone}`);
        } catch (e) { console.error('释放号码失败:', e); }
      }
    }

    // ====== 业务分发 ======
    switch (action) {
      case 'getApiConfig': {
        const cfg = await getSetting('__api_config__') || {};
        return jsonResponse({ success: true, apiUser: cfg.user || '', apiPass: cfg.pass || '', sid: cfg.sid || '24085', ascription: cfg.ascription || '', paragraph: cfg.paragraph || '', exclude: cfg.exclude || '', uid: cfg.uid || '' });
      }

      case 'saveApiConfig': {
        const newUser = url.searchParams.get('apiUser');
        const newPass = url.searchParams.get('apiPass');
        const existing = await getSetting('__api_config__') || {};
        let finalUser = existing.user || '';
        let finalPass = existing.pass || '';

        if (newUser && newPass) { finalUser = newUser; finalPass = newPass; }
        else if (newUser || newPass) { return jsonResponse({ error: '账号密码必须同时提供' }, 400); }
        else if (!finalUser || !finalPass) { return jsonResponse({ error: '首次配置需提供账号密码' }, 400); }

        const newConfig = {
          user: finalUser, pass: finalPass, sid: url.searchParams.get('sid') || existing.sid || '24085',
          ascription: url.searchParams.get('ascription') || '', paragraph: url.searchParams.get('paragraph') || '',
          exclude: url.searchParams.get('exclude') || '', uid: url.searchParams.get('uid') || ''
        };
        await setSetting('__api_config__', newConfig);
        if (finalUser !== existing.user || finalPass !== existing.pass) {
          await db.prepare(`DELETE FROM settings WHERE key='__token_data__'`).run();
        }
        return jsonResponse({ success: true });
      }

      case 'cancelRecvPhone': {
        const phone = url.searchParams.get('phone');
        try {
          const tokenStr = await getValidToken();
          const cancelUrl = `https://${HAOZHU.server}/sms/?api=cancelRecv&token=${tokenStr}&sid=${HAOZHU.sid}&phone=${encodeURIComponent(phone)}`;
          const cancelResp = await fetchWithTimeout(cancelUrl);
          const cancelData = await cancelResp.json();

          if (cancelData.code == 0 || cancelData.msg?.includes('成功')) {
            const pool = await getPool();
            const pEntry = pool.find(p => p.phone === phone);
            if (pEntry && pEntry.status === 'in_use') {
              if (pEntry.oid) {
                await db.prepare(`UPDATE orders SET status='released', phone=NULL, expire_at=NULL WHERE oid=?`).bind(pEntry.oid).run();
              }
              pEntry.status = 'available'; pEntry.oid = null; pEntry.expire = null;
              await savePool(pool);
            }
            return jsonResponse({ success: true, msg: cancelData.msg || '释放成功' });
          }
          return jsonResponse({ success: false, error: cancelData.msg || '平台释放失败' }, 400);
        } catch (e) {
          return jsonResponse({ error: '请求接码平台失败: ' + e.message }, 500);
        }
      }

      case 'listActiveOrders': {
        const now = Date.now();
        const { results } = await db.prepare(`SELECT oid, phone, expire_at as expire FROM orders WHERE status='active' AND expire_at > ?`).bind(now).all();
        return jsonResponse({ orders: results });
      }

      case 'listAllOrders': {
        const cursorStr = url.searchParams.get('cursor') || null;
        const limit = Math.min(parseInt(url.searchParams.get('limit')) || 100, 200);
        const start = cursorStr ? Math.max(parseInt(cursorStr) || 0, 0) : 0;
        
        const { results } = await db.prepare(
          `SELECT * FROM orders WHERE status='done' ORDER BY created_at DESC LIMIT ? OFFSET ?`
        ).bind(limit, start).all();

        const orders = results.map(o => ({
          oid: o.oid, phone: o.phone || '---', assignedPhone: o.assigned_phone || '',
          status: o.status, code: o.code || '', expire: o.expire_at, doneTime: o.done_time,
          createdAt: o.created_at, phoneAssignedAt: o.phone_assigned_at
        }));
        
        const countRes = await db.prepare(`SELECT COUNT(*) as total FROM orders WHERE status='done'`).first();
        
        return jsonResponse({
          orders, cursor: orders.length === limit ? String(start + limit) : null,
          list_complete: orders.length < limit, total: countRes.total
        });
      }

      case 'releaseAllOrders': {
        const { results } = await db.prepare(`SELECT * FROM orders WHERE status='active'`).all();
        let successCount = 0;
        for (const order of results) {
          await releaseOrderPhone({ phone: order.phone, fromPool: order.from_pool, sid: order.sid }, order.oid);
          await db.prepare(`UPDATE orders SET status='released', phone=NULL, expire_at=NULL WHERE oid=?`).bind(order.oid).run();
          successCount++;
        }
        return jsonResponse({ success: true, released: successCount, total: results.length });
      }

      case 'createOrder': {
        const existing = await db.prepare(`SELECT oid FROM orders WHERE oid=?`).bind(oid).first();
        if (existing) return jsonResponse({ error: '订单已存在' }, 400);

        const specifiedPhone = url.searchParams.get('phone') || '';
        const filters = {
          ascription: url.searchParams.get('ascription') || '',
          paragraph: url.searchParams.get('paragraph') || '',
          exclude: url.searchParams.get('exclude') || '',
          isp: url.searchParams.get('isp') || '',
          province: url.searchParams.get('Province') || '',
          uid: url.searchParams.get('uid') || ''
        };
        
        await db.prepare(
          `INSERT INTO orders (oid, sid, assigned_phone, status, created_at, filters_json) 
           VALUES (?, ?, ?, 'new', ?, ?)`
        ).bind(oid, sid, specifiedPhone, Date.now(), JSON.stringify(filters)).run();

        return jsonResponse({ success: true });
      }

      case 'getPhone': {
        const order = await db.prepare(`SELECT * FROM orders WHERE oid=?`).bind(oid).first();
        if (!order) return jsonResponse({ error: '订单不存在或已失效' }, 404);
        if (order.status === 'done') return jsonResponse({ error: '订单已完成' }, 403);
        if (order.status === 'released') return jsonResponse({ error: '订单已被管理员释放' }, 403);

        if (order.status === 'active' && order.expire_at && Date.now() < order.expire_at) {
          return jsonResponse({ phone: order.phone, expire: order.expire_at });
        }

        if (order.phone) {
          await releaseOrderPhone({ phone: order.phone, fromPool: order.from_pool, sid: order.sid }, oid);
        }

        const tokenStr = await getValidToken();
        const orderSid = order.sid || HAOZHU.sid;

        if (order.assigned_phone) {
          const reqUrl = `https://${HAOZHU.server}/sms/?api=getPhone&token=${tokenStr}&sid=${orderSid}&phone=${encodeURIComponent(order.assigned_phone)}`;
          const phoneResp = await fetchWithTimeout(reqUrl);
          const phoneData = await phoneResp.json();
          if (phoneData.code == 0) {
            const realPhone = phoneData.phone || phoneData.Phone || phoneData.mobile || order.assigned_phone;
            const expireAt = Date.now() + PHONE_TTL_MS;
            await db.prepare(`UPDATE orders SET phone=?, expire_at=?, status='active', code=NULL, from_pool=0, phone_assigned_at=? WHERE oid=?`)
              .bind(realPhone, expireAt, Date.now(), oid).run();
            return jsonResponse({ phone: realPhone, expire: expireAt });
          }
          return jsonResponse({ error: '获取指定手机号失败：' + (phoneData.msg || '平台无该号或已被占用') }, 400);
        }

        const pool = await getPool();
        const available = pool.filter(p => p.status === 'available');
        if (available.length > 0) {
          const chosen = available[Math.floor(Math.random() * available.length)];
          const phone = chosen.phone;
          const expireAt = Date.now() + PHONE_TTL_MS;
          try {
            await fetchWithTimeout(`https://${HAOZHU.server}/sms/?api=getPhone&token=${tokenStr}&sid=${orderSid}&phone=${phone}`);
          } catch (e) {}
          
          chosen.status = 'in_use'; chosen.oid = oid; chosen.expire = expireAt;
          await savePool(pool);
          
          await db.prepare(`UPDATE orders SET phone=?, expire_at=?, status='active', code=NULL, from_pool=1, phone_assigned_at=? WHERE oid=?`)
              .bind(phone, expireAt, Date.now(), oid).run();
          return jsonResponse({ phone, expire: expireAt });
        }

        const f = JSON.parse(order.filters_json || '{}');
        let apiUrl = `https://${HAOZHU.server}/sms/?api=getPhone&token=${tokenStr}&sid=${orderSid}`;
        if (f.ascription) apiUrl += `&ascription=${encodeURIComponent(f.ascription)}`;
        if (f.paragraph)  apiUrl += `&paragraph=${encodeURIComponent(f.paragraph)}`;
        if (f.exclude)    apiUrl += `&exclude=${encodeURIComponent(f.exclude)}`;
        if (f.isp)        apiUrl += `&isp=${encodeURIComponent(f.isp)}`;
        if (f.province)   apiUrl += `&Province=${encodeURIComponent(f.province)}`;
        if (f.uid)        apiUrl += `&uid=${encodeURIComponent(f.uid)}`;

        const phoneResp = await fetchWithTimeout(apiUrl);
        const phoneData = await phoneResp.json();
        if (phoneData.code == 0) {
          const phone = phoneData.phone || phoneData.Phone || phoneData.mobile;
          const expireAt = Date.now() + PHONE_TTL_MS;
          await db.prepare(`UPDATE orders SET phone=?, expire_at=?, status='active', code=NULL, from_pool=0, phone_assigned_at=? WHERE oid=?`)
              .bind(phone, expireAt, Date.now(), oid).run();
          return jsonResponse({ phone, expire: expireAt });
        }
        return jsonResponse({ error: phoneData.msg || '取号失败' }, 500);
      }

      case 'getSMS': {
        const order = await db.prepare(`SELECT * FROM orders WHERE oid=?`).bind(oid).first();
        if (!order) return jsonResponse({ error: '订单不存在' }, 404);

        if (order.status === 'active' && order.expire_at && Date.now() >= order.expire_at) {
          return jsonResponse({ status: 'expired', code: null });
        }

        if (!order.phone) return jsonResponse({ error: '订单不存在' }, 404);
        if (order.status === 'done' && order.code) {
          return jsonResponse({ code: order.code, status: 'done' });
        }
        if (order.status !== 'active') return jsonResponse({ status: order.status, code: order.code || null });

        const tokenStr = await getValidToken();
        const orderSid = order.sid || HAOZHU.sid;
        const smsResp = await fetchWithTimeout(`https://${HAOZHU.server}/sms/?api=getMessage&token=${tokenStr}&sid=${orderSid}&phone=${order.phone}`);
        const smsData = await smsResp.json();

        if (smsData.code == 0) {
          const raw = smsData.sms || smsData.Sms || smsData.message || smsData.code_text || '';
          if (raw) {
            const match = raw.match(/(?<!\d)(\d{4,6})(?!\d)/);
            if (match) {
              const code = match[1];
              await db.prepare(`UPDATE orders SET code=?, status='done', done_time=? WHERE oid=?`)
                .bind(code, Date.now(), oid).run();
              await addLog(order.phone, oid, 'sms_received');
              return jsonResponse({ code, status: 'done' });
            }
          }
        }
        return jsonResponse({ code: null, status: 'active' });
      }

      case 'status': {
        const order = await db.prepare(`SELECT * FROM orders WHERE oid=?`).bind(oid).first();
        if (!order) return jsonResponse({ status: 'invalid', phone: null, expire: null, code: null });
        
        if (order.status === 'active' && order.expire_at && Date.now() >= order.expire_at) {
          return jsonResponse({ status: 'expired', phone: order.phone, expire: null, code: null });
        }
        return jsonResponse({ status: order.status, phone: order.phone, expire: order.expire_at, code: order.code });
      }

      case 'release': {
        const order = await db.prepare(`SELECT * FROM orders WHERE oid=?`).bind(oid).first();
        if (!order) return jsonResponse({ error: '订单不存在' }, 404);
        if (order.status === 'done') return jsonResponse({ error: '订单已完成' }, 403);

        if (order.phone) await releaseOrderPhone({ phone: order.phone, fromPool: order.from_pool, sid: order.sid }, oid);
        
        await db.prepare(`UPDATE orders SET status='new', phone=NULL, expire_at=NULL, code=NULL, from_pool=0 WHERE oid=?`).bind(oid).run();
        return jsonResponse({ success: true });
      }

      case 'logList': {
        const { results } = await db.prepare(`SELECT * FROM logs ORDER BY time DESC LIMIT 100`).all();
        return jsonResponse({ logs: results });
      }

      // ====== 保留原有功能 ======
      case 'generateCard': {
        const type = url.searchParams.get('type') || 'trial';
        const count = parseInt(url.searchParams.get('count')) || 1;
        if (count < 1 || count > 100) return jsonResponse({ error: '数量需在1-100之间' }, 400);
        const duration = type === 'month' ? 30 : 1;
        const cards = await getCards();
        const generated = [];
        for (let i = 0; i < count; i++) {
          const key = generateCardKey();
          cards.push({ key, type, duration, activated: false, activated_at: null, expire_at: null, created_at: Date.now() });
          generated.push(key);
        }
        await saveCards(cards);
        return jsonResponse({ success: true, keys: generated });
      }
      case 'activateCard': {
        const key = url.searchParams.get('key');
        if (!key) return jsonResponse({ error: '缺少卡密' }, 400);
        const cards = await getCards();
        const card = cards.find(c => c.key === key);
        if (!card) return jsonResponse({ error: '卡密不存在' }, 404);
        if (card.activated) {
          if (Date.now() > card.expire_at) return jsonResponse({ error: '卡密已过期' }, 400);
          return jsonResponse({ success: true, expire_at: card.expire_at });
        }
        const now = Date.now();
        card.activated = true; card.activated_at = now;
        card.expire_at = now + card.duration * 86400 * 1000;
        await saveCards(cards);
        return jsonResponse({ success: true, expire_at: card.expire_at });
      }
      case 'verifyCard': {
        const key = url.searchParams.get('key');
        if (!key) return jsonResponse({ error: '缺少卡密' }, 400);
        const cards = await getCards();
        const card = cards.find(c => c.key === key);
        if (!card) return jsonResponse({ error: '卡密不存在' }, 404);
        if (!card.activated) return jsonResponse({ valid: false, msg: '未激活' });
        if (Date.now() > card.expire_at) return jsonResponse({ valid: false, msg: '已过期' });
        return jsonResponse({ valid: true, expire_at: card.expire_at });
      }
      case 'cardList': {
        const cards = await getCards();
        return jsonResponse({ cards });
      }
      case 'deleteCard': {
        const key = url.searchParams.get('key');
        if (!key) return jsonResponse({ error: '缺少卡密' }, 400);
        let cards = await getCards();
        cards = cards.filter(c => c.key !== key);
        await saveCards(cards);
        return jsonResponse({ success: true });
      }
      case 'getBalance': {
        const tokenStr = await getValidToken();
        const balanceResp = await fetchWithTimeout(`https://${HAOZHU.server}/sms/?api=getSummary&token=${tokenStr}`);
        const balanceData = await balanceResp.json();
        if (balanceData.code == 0) {
          const bal = balanceData.balance || balanceData.summary || balanceData.money || balanceData.data?.balance || balanceData.data?.money || balanceData.amount;
          return jsonResponse({ balance: bal });
        }
        return jsonResponse({ error: balanceData.msg || '查询失败' });
      }
      case 'blockPhone': {
        const phone = url.searchParams.get('phone');
        if (!phone) return jsonResponse({ error: '缺少 phone 参数' }, 400);
        const tokenStr = await getValidToken();
        const blockResp = await fetchWithTimeout(`https://${HAOZHU.server}/sms/?api=addBlacklist&token=${tokenStr}&sid=${HAOZHU.sid}&phone=${phone}`);
        const blockData = await blockResp.json();
        if (blockData.code == 0) {
          let pool = await getPool();
          pool = pool.filter(p => p.phone !== phone);
          await savePool(pool);
          return jsonResponse({ success: true });
        }
        return jsonResponse({ error: blockData.msg || '拉黑失败' });
      }
      case 'lockOrder': {
        const order = await db.prepare(`SELECT * FROM orders WHERE oid=?`).bind(oid).first();
        if (!order) return jsonResponse({ error: '订单不存在' }, 404);
        if (order.status === 'done') return jsonResponse({ error: '订单已完成，无法释放' }, 400);
        await releaseOrderPhone({ phone: order.phone, fromPool: order.from_pool, sid: order.sid }, oid);
        await db.prepare(`UPDATE orders SET status='released', phone=NULL, expire_at=NULL, code=NULL WHERE oid=?`).bind(oid).run();
        return jsonResponse({ success: true });
      }
      case 'poolList': {
        const pool = await getPool();
        return jsonResponse({ pool });
      }
      case 'addPhone': {
        const phone = url.searchParams.get('phone');
        if (!phone) return jsonResponse({ error: '缺少 phone 参数' }, 400);
        const pool = await getPool();
        if (pool.some(p => p.phone === phone)) return jsonResponse({ error: '号码已存在' }, 400);
        pool.push({ phone, status: 'available', oid: null, expire: null });
        await savePool(pool);
        return jsonResponse({ success: true });
      }
      case 'removePhone': {
        const phone = url.searchParams.get('phone');
        if (!phone) return jsonResponse({ error: '缺少 phone 参数' }, 400);
        let pool = await getPool();
        pool = pool.filter(p => p.phone !== phone);
        await savePool(pool);
        return jsonResponse({ success: true });
      }
      case 'resetPool': {
        const pool = await getPool();
        for (const p of pool) {
          if (p.status === 'in_use' && p.oid) {
            await db.prepare(`UPDATE orders SET status='released', phone=NULL, expire_at=NULL WHERE oid=?`).bind(p.oid).run();
            p.status = 'available'; p.oid = null; p.expire = null;
          }
        }
        await savePool(pool);
        return jsonResponse({ success: true });
      }
      case 'releasePoolPhone': {
        const phone = url.searchParams.get('phone');
        if (!phone) return jsonResponse({ error: '缺少 phone 参数' }, 400);
        const pool = await getPool();
        const entry = pool.find(p => p.phone === phone);
        if (!entry) return jsonResponse({ error: '号码不在池中' }, 404);
        if (entry.status !== 'in_use') return jsonResponse({ error: '该号码未被占用' }, 400);
        if (entry.oid) {
          await db.prepare(`UPDATE orders SET status='released', phone=NULL, expire_at=NULL WHERE oid=?`).bind(entry.oid).run();
        }
        entry.status = 'available'; entry.oid = null; entry.expire = null;
        await savePool(pool);
        return jsonResponse({ success: true });
      }
      case 'setPhone': {
        const phone = url.searchParams.get('phone');
        if (!phone) return jsonResponse({ error: '缺少 phone 参数' }, 400);
        await db.prepare(
          `INSERT INTO orders (oid, sid, phone, expire_at, status, created_at) 
           VALUES (?, ?, ?, 0, 'pending', ?) 
           ON CONFLICT(oid) DO UPDATE SET phone=excluded.phone, status='pending'`
        ).bind(oid, sid, phone, Date.now()).run();
        return jsonResponse({ success: true });
      }

      default:
        return jsonResponse({ error: '未知操作' }, 400);
    }

  } catch (e) {
    return new Response(JSON.stringify({ error: 'Worker 内部异常: ' + e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }
    });
  }
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0' }
  });
}
