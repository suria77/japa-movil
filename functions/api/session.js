// Función de Cloudflare Pages: GET /api/session
// Recupera la sesión de la app a partir de la cookie del servidor (jp_sess) que crea
// verify-license.js al entrar con una licencia válida. La app solo la usa si el móvil
// ha perdido la sesión que guarda localmente.
//
// Comprueba además que ese dispositivo siga siendo uno de los 2 permitidos: si se liberó
// para entrar en otro, la sesión deja de valer y se vuelve a pedir la licencia.
// Usa las mismas variables de Upstash que verify-license.js; no necesita claves nuevas.

const SESSION_COOKIE = 'jp_sess';

async function kvCommand(env, command) {
  const r = await fetch(env.UPSTASH_REDIS_REST_URL, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + env.UPSTASH_REDIS_REST_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(command)
  });
  const rawText = await r.text();
  let data = null;
  try { data = JSON.parse(rawText); } catch (e) { data = null; }
  if (!r.ok || !data || data.error) {
    throw new Error('KV ' + command[0] + ' falló (estado ' + r.status + ')');
  }
  return data.result;
}

async function kvGet(env, key) {
  const result = await kvCommand(env, ['GET', key]);
  if (result === null || result === undefined) return null;
  if (typeof result === 'string') {
    try { return JSON.parse(result); } catch (e) { return result; }
  }
  return result;
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  const parts = header.split(';');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i].trim();
    if (p.indexOf(name + '=') === 0) return p.slice(name.length + 1);
  }
  return null;
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const token = readCookie(request, SESSION_COOKIE);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) {
    return json(200, { valid: false });
  }
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) {
    return json(200, { valid: false });
  }
  try {
    const session = await kvGet(env, 'session:' + token);
    if (!session || !session.license_key) return json(200, { valid: false });

    // ¿Sigue siendo este dispositivo uno de los permitidos?
    if (session.device_id) {
      const devices = await kvGet(env, 'license_devices:' + session.license_key);
      if (!Array.isArray(devices) || devices.indexOf(session.device_id) === -1) {
        return json(200, { valid: false });
      }
    }
    return json(200, { valid: true, email: session.email, device_id: session.device_id || null });
  } catch (e) {
    return json(200, { valid: false });
  }
}
