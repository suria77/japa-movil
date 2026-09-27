// Función de Cloudflare Pages (Workers runtime) — se ejecuta en el servidor, nunca en el navegador.
// La Secret Key de Payhip vive SOLO aquí, leída de una variable de entorno de Cloudflare
// (Proyecto > Settings > Variables and Secrets > PAYHIP_SECRET_KEY), nunca escrita en este archivo.
//
// Formato confirmado por soporte de Payhip (16/09/2026):
//   GET https://payhip.com/api/v2/license/verify?license_key=...
//   Cabecera: product-secret-key: <tu Secret Key>
//   Si la licencia no es válida, Payhip devuelve una respuesta vacía (sin motivo detallado).
//
// Límite de dispositivos: una vez que Payhip confirma que la licencia es válida, se
// comprueba además cuántos dispositivos distintos la han usado ya, guardado en Upstash Redis
// vía su API REST (variables de entorno UPSTASH_REDIS_REST_URL y UPSTASH_REDIS_REST_TOKEN,
// configuradas en Cloudflare Pages > Settings > Environment variables).
// Máximo 2 dispositivos por licencia.

const MAX_DEVICES = 2;

async function kvCommand(env, command) {
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(command)
  });
  const rawText = await r.text();
  let data = null;
  try { data = JSON.parse(rawText); } catch (e) { data = null; }
  if (!r.ok || !data || data.error) {
    throw new Error('KV ' + command[0] + ' falló (estado ' + r.status + '): ' + rawText.slice(0, 200));
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

async function kvSet(env, key, value) {
  await kvCommand(env, ['SET', key, JSON.stringify(value)]);
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

// Cloudflare Pages Functions: este nombre especial captura POST a /api/verify-license
export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json(400, { valid: false, message: 'Cuerpo de la petición inválido.' });
  }

  const { email, license_key, device_id } = body || {};

  if (!email || !license_key) {
    return json(400, { valid: false, message: 'Falta el correo o el código de licencia.' });
  }

  const secretKey = env.PAYHIP_SECRET_KEY;
  if (!secretKey) {
    return json(500, { valid: false, message: 'Falta configurar la clave secreta en el servidor (PAYHIP_SECRET_KEY).' });
  }

  try {
    const url = 'https://payhip.com/api/v2/license/verify?license_key=' + encodeURIComponent(String(license_key).trim());

    const payhipResponse = await fetch(url, {
      method: 'GET',
      headers: {
        'product-secret-key': secretKey
      }
    });

    const rawText = await payhipResponse.text();
    let resultado = null;
    try { resultado = JSON.parse(rawText); } catch (e) { resultado = null; }

    const data = resultado && resultado.data;

    if (!data) {
      // Licencia no encontrada / no válida: Payhip devuelve una respuesta vacía en este caso.
      return json(200, { valid: false, message: 'El código de licencia no es válido.' });
    }

    if (data.enabled === false) {
      return json(200, { valid: false, message: 'Esta licencia ha sido desactivada.' });
    }

    const buyerEmail = String(data.buyer_email || '').toLowerCase().trim();
    const enteredEmail = String(email).toLowerCase().trim();

    if (buyerEmail && buyerEmail !== enteredEmail) {
      return json(200, { valid: false, message: 'Ese código de licencia no corresponde a ese correo electrónico.' });
    }

    // --- Límite de dispositivos (con opción de liberar uno, estilo Netflix) ---
    if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) {
      return json(500, { valid: false, message: 'Falta activar el almacenamiento de dispositivos en el servidor (Upstash).' });
    }

    const deviceKey = 'license_devices:' + String(license_key).trim();
    let devices = [];
    try {
      const stored = await kvGet(env, deviceKey);
      if (Array.isArray(stored)) devices = stored;
    } catch (e) {
      return json(200, { valid: false, message: 'DEPURACIÓN — Error leyendo dispositivos: ' + e.message });
    }

    const thisDevice = String(device_id || '').trim();
    const confirmRelease = body && body.confirm_release === true;

    if (thisDevice && devices.indexOf(thisDevice) === -1) {
      if (devices.length >= MAX_DEVICES) {
        if (!confirmRelease) {
          return json(200, {
            valid: false,
            needs_release: true,
            message: 'Esta licencia ya está en uso en ' + MAX_DEVICES + ' dispositivos. Puedes liberar uno de ellos para entrar en este.'
          });
        }
        // Confirmado: se libera el dispositivo más antiguo y se añade el nuevo.
        devices.shift();
      }
      devices.push(thisDevice);
      await kvSet(env, deviceKey, devices);
    }

    return json(200, { valid: true, message: 'Acceso concedido.' });
  } catch (err) {
    return json(500, { valid: false, message: 'DEPURACIÓN — Error: ' + err.message });
  }
}

// Cualquier otro método a esta ruta
export async function onRequest(context) {
  if (context.request.method !== 'POST') {
    return json(405, { valid: false, message: 'Método no permitido.' });
  }
  return onRequestPost(context);
}
