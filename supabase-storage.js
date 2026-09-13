/* ============================================================
   KARDEX — puente de almacenamiento hacia Supabase
   ------------------------------------------------------------
   Crea window.storage con la misma forma que usa la app
   (get / set / list / delete) para que el KARDEX guarde en la
   nube sin cambiar el resto del código.

   Cargue este archivo ANTES del script del KARDEX:
       <script src="supabase-storage.js"></script>

   Solo hay que llenar los tres datos de CONFIG.
   ============================================================ */
(function () {
  "use strict";

  var CONFIG = {
    // 1) Pegue aquí la URL de su proyecto de Supabase
    URL: 'https://uaketjzcyvokdnopnyxy.supabase.co',

    // 2) Pegue aquí la llave "anon public" del proyecto
    ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVha2V0anpjeXZva2Rub3BueXh5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkzMDczMjcsImV4cCI6MjEwNDg4MzMyN30.8Y0VTDSwFUsxruDwHmSbxlLRKQlRgCqQv6doigB11Os',

    // 3) Nombre de la tabla (déjelo así si siguió las instrucciones)
    TABLA: 'kardex_store',

    // 4) Pedir clave para entrar.
    //    false = arranca sin clave (más fácil para probar)
    //    true  = cada dispositivo pide la clave una vez
    USAR_CLAVE: false,

    // Correo de la cuenta compartida del equipo (solo si USAR_CLAVE es true)
    CUENTA: 'kardex@luxuryckdesign.com'
  };

  var REST = CONFIG.URL + '/rest/v1/' + CONFIG.TABLA;
  var AUTH = CONFIG.URL + '/auth/v1';
  var LOCAL_PREFIX = 'kardex-local:';
  var TOKEN_KEY = 'kardex:sb-token';

  var session = null;   // { access_token, refresh_token, expira }
  var listo = null;     // promesa de arranque

  /* ---------- sesión ---------- */

  function guardarSesion(data) {
    session = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expira: Date.now() + (data.expires_in ? data.expires_in * 1000 : 3600000) - 60000
    };
    try { localStorage.setItem(TOKEN_KEY, JSON.stringify(session)); } catch (e) {}
  }

  function borrarSesion() {
    session = null;
    try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
  }

  function pedirClave() {
    var clave = window.prompt('Clave del equipo para entrar al KARDEX:');
    return clave ? clave.trim() : '';
  }

  async function entrar(clave) {
    var r = await fetch(AUTH + '/token?grant_type=password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: CONFIG.ANON_KEY },
      body: JSON.stringify({ email: CONFIG.CUENTA, password: clave })
    });
    if (!r.ok) return false;
    guardarSesion(await r.json());
    return true;
  }

  async function renovar() {
    if (!session || !session.refresh_token) return false;
    var r = await fetch(AUTH + '/token?grant_type=refresh_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: CONFIG.ANON_KEY },
      body: JSON.stringify({ refresh_token: session.refresh_token })
    });
    if (!r.ok) { borrarSesion(); return false; }
    guardarSesion(await r.json());
    return true;
  }

  async function arrancar() {
    if (!CONFIG.USAR_CLAVE) return;
    try {
      var guardada = localStorage.getItem(TOKEN_KEY);
      if (guardada) session = JSON.parse(guardada);
    } catch (e) {}
    if (session && Date.now() < session.expira) return;
    if (session && await renovar()) return;
    for (var i = 0; i < 3; i++) {
      var clave = pedirClave();
      if (clave && await entrar(clave)) return;
      window.alert('Clave incorrecta.');
    }
    throw new Error('sin acceso');
  }

  function preparado() {
    if (!listo) listo = arrancar().catch(function (e) { listo = null; throw e; });
    return listo;
  }

  async function cabeceras(extra) {
    var h = {
      apikey: CONFIG.ANON_KEY,
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + CONFIG.ANON_KEY
    };
    if (CONFIG.USAR_CLAVE) {
      if (session && Date.now() >= session.expira) await renovar();
      if (session) h.Authorization = 'Bearer ' + session.access_token;
    }
    if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) h[k] = extra[k];
    return h;
  }

  /* ---------- red con reintento por token vencido ---------- */

  async function pedir(url, opciones, reintento) {
    var r = await fetch(url, opciones);
    if (r.status === 401 && CONFIG.USAR_CLAVE && !reintento) {
      if (await renovar()) {
        opciones.headers = await cabeceras(opciones.headers && opciones.headers.Prefer ? { Prefer: opciones.headers.Prefer } : null);
        return pedir(url, opciones, true);
      }
    }
    return r;
  }

  /* ---------- almacenamiento local (datos del dispositivo) ---------- */

  function localGet(key) {
    var v = localStorage.getItem(LOCAL_PREFIX + key);
    return v === null ? null : { key: key, value: v, shared: false };
  }

  /* ---------- API pública ---------- */

  var storage = {
    async get(key, shared) {
      if (!shared) return localGet(key);
      await preparado();
      var url = REST + '?key=eq.' + encodeURIComponent(key) + '&select=value';
      var r = await pedir(url, { headers: await cabeceras() });
      if (!r.ok) throw new Error('Supabase get ' + r.status);
      var filas = await r.json();
      if (!filas.length) return null;
      var v = filas[0].value;
      return { key: key, value: typeof v === 'string' ? v : JSON.stringify(v), shared: true };
    },

    async set(key, value, shared) {
      if (!shared) {
        localStorage.setItem(LOCAL_PREFIX + key, value);
        return { key: key, value: value, shared: false };
      }
      await preparado();
      var cuerpo = JSON.stringify({ key: key, value: value, updated_at: new Date().toISOString() });
      var r = await pedir(REST + '?on_conflict=key', {
        method: 'POST',
        headers: await cabeceras({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: cuerpo
      });
      if (!r.ok) throw new Error('Supabase set ' + r.status);
      return { key: key, value: value, shared: true };
    },

    async delete(key, shared) {
      if (!shared) {
        localStorage.removeItem(LOCAL_PREFIX + key);
        return { key: key, deleted: true, shared: false };
      }
      await preparado();
      var r = await pedir(REST + '?key=eq.' + encodeURIComponent(key), {
        method: 'DELETE',
        headers: await cabeceras()
      });
      if (!r.ok) throw new Error('Supabase delete ' + r.status);
      return { key: key, deleted: true, shared: true };
    },

    async list(prefix, shared) {
      prefix = prefix || '';
      if (!shared) {
        var claves = [];
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (k.indexOf(LOCAL_PREFIX) === 0) {
            var limpia = k.slice(LOCAL_PREFIX.length);
            if (limpia.indexOf(prefix) === 0) claves.push(limpia);
          }
        }
        return { keys: claves, prefix: prefix, shared: false };
      }
      await preparado();
      var url = REST + '?select=key' + (prefix ? '&key=like.' + encodeURIComponent(prefix + '%') : '');
      var r = await pedir(url, { headers: await cabeceras() });
      if (!r.ok) throw new Error('Supabase list ' + r.status);
      var filas = await r.json();
      return { keys: filas.map(function (f) { return f.key; }), prefix: prefix, shared: true };
    }
  };

  window.storage = storage;
})();
