// Almacén común de notas, palabras y respuestas de cada alumno.
// Ruta: /<alumno>/api  (p. ej. /ilya/api). Cloudflare Access protege /<alumno>/*,
// y aquí se comprueba además la firma del token de Access.
// Necesita una base de datos D1 vinculada al proyecto con el nombre DB.

const STUDENTS = ["ilya", "maria"];
const TEAM = "https://clases-espanol-pages.cloudflareaccess.com";
const MAX_VALUE = 200000;

let ready = null;
function setup(db) {
  if (!ready) ready = db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS kv (student TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (student, k))"),
    db.prepare("CREATE INDEX IF NOT EXISTS kv_ts ON kv (student, ts)")
  ]).catch(e => { ready = null; throw e; });
  return ready;
}

let certs = null, certsAt = 0;
async function getKeys() {
  if (!certs || Date.now() - certsAt > 3600e3) {
    const r = await fetch(TEAM + "/cdn-cgi/access/certs");
    if (!r.ok) throw new Error("certs");
    certs = (await r.json()).keys || [];
    certsAt = Date.now();
  }
  return certs;
}
const b64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
async function verifyAccess(req) {
  const jwt = req.headers.get("Cf-Access-Jwt-Assertion");
  if (!jwt) return false;
  const [h, p, s] = jwt.split(".");
  if (!s) return false;
  try {
    const head = JSON.parse(new TextDecoder().decode(b64u(h)));
    const body = JSON.parse(new TextDecoder().decode(b64u(p)));
    if (body.iss !== TEAM || !(body.exp * 1000 > Date.now())) return false;
    const jwk = (await getKeys()).find(k => k.kid === head.kid);
    if (!jwk) { certs = null; return false; }
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64u(s), new TextEncoder().encode(h + "." + p));
  } catch (e) { return false; }
}

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});

export async function onRequest({ request, env, params }) {
  const student = params.student;
  if (!STUDENTS.includes(student)) return json({ error: "not found" }, 404);
  if (!(await verifyAccess(request))) return json({ error: "no access" }, 401);
  if (!env.DB) return json({ error: "no db" }, 503);
  await setup(env.DB);

  if (request.method === "GET") {
    const since = Number(new URL(request.url).searchParams.get("since")) || 0;
    const { results } = await env.DB.prepare("SELECT k, v, ts FROM kv WHERE student = ? AND ts > ?")
      .bind(student, since).all();
    return json({ now: Date.now(), items: results });
  }

  if (request.method === "POST") {
    let data;
    try { data = await request.json(); } catch (e) { return json({ error: "bad json" }, 400); }
    const set = data && typeof data.set === "object" ? data.set : {};
    const keys = Object.keys(set).filter(k => k.length <= 200 && typeof set[k] === "string" && set[k].length <= MAX_VALUE).slice(0, 500);
    const ts = Date.now();
    if (keys.length) await env.DB.batch(keys.map(k =>
      env.DB.prepare("INSERT INTO kv (student, k, v, ts) VALUES (?, ?, ?, ?) ON CONFLICT (student, k) DO UPDATE SET v = excluded.v, ts = excluded.ts")
        .bind(student, k, set[k], ts)));
    return json({ ts, saved: keys });
  }

  return json({ error: "method" }, 405);
}
