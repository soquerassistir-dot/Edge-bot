/* ============================================================
   HTMLBlox — Bot "Bloxel"
   Sobe um servidor HTTP (para o Render não dormir + Uptime Robot
   pingar /health) e em paralelo aceita friend requests e manda
   mensagem de boas-vindas automaticamente.
   ============================================================ */

import http from 'node:http';
import { createClient } from '@supabase/supabase-js';

/* ============================================================
   ⚙️  CONFIGURAÇÃO — vem das variáveis de ambiente do Render
   ============================================================ */
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_ANON = process.env.SUPABASE_ANON;
const BOT_EMAIL     = process.env.BOT_EMAIL;
const BOT_PASSWORD  = process.env.BOT_PASSWORD;

/* ============================================================
   ⚙️  NOMES DAS TABELAS/COLUNAS (ajustados pro seu schema)
   ============================================================ */
const FRIEND_TABLE   = 'friend_requests';
const MESSAGE_TABLE  = 'direct_messages';
const MSG_COL_SENDER = 'sender_id';
const MSG_COL_RECV   = 'receiver_id';
const MSG_COL_BODY   = 'text';   // 👈 sua coluna de texto se chama "text"
/* ============================================================ */

const BOT_DISPLAY_NAME = 'Bloxel';

const WELCOME_MESSAGE =
  "Hello, I'm Bloxel, an official HTMLBlox bot used to test all new updates. " +
  'Say "hi" if you received this message! Thanks for your attention!';

const PORT = process.env.PORT || 10000;

/* ============================================================
   VALIDAÇÃO DAS VARIÁVEIS
   ============================================================ */
if (!SUPABASE_URL || !SUPABASE_ANON || !BOT_EMAIL || !BOT_PASSWORD) {
  console.error('[Bloxel] FATAL: faltam variáveis de ambiente. Veja o Render → Environment.');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: { persistSession: false, autoRefreshToken: true }
});

let BOT_ID = null;
let BOT_USERNAME = null;

const log  = (...a) => console.log('[Bloxel]', new Date().toISOString(), ...a);
const warn = (...a) => console.warn('[Bloxel]', new Date().toISOString(), ...a);

/* ============================================================
   LOGIN
   ============================================================ */
async function login() {
  const { data, error } = await sb.auth.signInWithPassword({
    email: BOT_EMAIL,
    password: BOT_PASSWORD
  });
  if (error) throw new Error('Login falhou: ' + error.message);

  BOT_ID = data.user.id;

  const { data: prof } = await sb
    .from('profiles')
    .select('username')
    .eq('id', BOT_ID)
    .maybeSingle();

  BOT_USERNAME = prof?.username || BOT_DISPLAY_NAME;
  log(`Logado como ${BOT_USERNAME} (${BOT_ID})`);
}

/* ============================================================
   ACEITAR PEDIDO
   ============================================================ */
async function acceptFriendRequest(req) {
  // Tenta RPC primeiro (respeita RLS)
  const { error: rpcErr } = await sb.rpc('accept_friend_request', {
    request_id: req.id
  });

  if (!rpcErr) return true;

  // Fallback: UPDATE direto
  warn('RPC falhou, tentando UPDATE direto:', rpcErr.message);
  const { error: upErr } = await sb
    .from(FRIEND_TABLE)
    .update({ status: 'accepted', updated_at: new Date().toISOString() })
    .eq('id', req.id)
    .eq('receiver_id', BOT_ID);

  if (upErr) {
    warn('UPDATE também falhou:', upErr.message);
    return false;
  }
  return true;
}

/* ============================================================
   ENVIAR MENSAGEM
   ============================================================ */
async function sendWelcomeMessage(receiverId) {
  const row = {
    [MSG_COL_SENDER]: BOT_ID,
    [MSG_COL_RECV]:   receiverId,
    [MSG_COL_BODY]:   WELCOME_MESSAGE,
    created_at:       new Date().toISOString()
  };

  const { error } = await sb.from(MESSAGE_TABLE).insert(row);
  if (error) {
    warn('Falha ao enviar mensagem:', error.message);
    return false;
  }
  log(`✉  Mensagem enviada para ${receiverId}`);
  return true;
}

/* ============================================================
   PROCESSAR UM PEDIDO
   ============================================================ */
async function handleRequest(req) {
  if (!req || req.status !== 'pending') return;
  if (req.receiver_id !== BOT_ID) return;

  log(`📨 Novo pedido de ${req.sender_id}`);

  const ok = await acceptFriendRequest(req);
  if (!ok) return;

  log(`✅ Aceito: ${req.id}`);
  await sendWelcomeMessage(req.sender_id);
}

/* ============================================================
   BOOTSTRAP — pega tudo que ficou pendente
   ============================================================ */
async function processPending() {
  const { data, error } = await sb
    .from(FRIEND_TABLE)
    .select('*')
    .eq('receiver_id', BOT_ID)
    .eq('status', 'pending');

  if (error) { warn('Erro listando pendentes:', error.message); return; }
  if (data.length > 0) log(`📋 ${data.length} pendente(s)`);

  for (const req of data) {
    await handleRequest(req);
    await new Promise(r => setTimeout(r, 400));
  }
}

/* ============================================================
   REALTIME — escuta novos pedidos
   ============================================================ */
function listenRealtime() {
  sb.channel('bloxel-friend-requests')
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: FRIEND_TABLE,
        filter: `receiver_id=eq.${BOT_ID}`
      },
      (payload) => {
        log('🔔 Realtime INSERT');
        handleRequest(payload.new).catch(e => warn(e));
      }
    )
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: FRIEND_TABLE,
        filter: `receiver_id=eq.${BOT_ID}`
      },
      (payload) => {
        if (payload.new?.status === 'pending' && payload.old?.status !== 'pending') {
          log('🔔 Realtime UPDATE → pending');
          handleRequest(payload.new).catch(e => warn(e));
        }
      }
    )
    .subscribe((status) => {
      log('Realtime:', status);
      if (status === 'SUBSCRIBED') processPending().catch(e => warn(e));
    });
}

/* ============================================================
   HEARTBEAT + POLLING DE SEGURANÇA
   ============================================================ */
function heartbeat() {
  // Relogin automático se a sessão expirar (a cada 5 min)
  setInterval(async () => {
    const { data } = await sb.auth.getSession();
    if (!data?.session) {
      warn('Sessão expirou — relogando...');
      try { await login(); } catch (e) { warn(e); }
    }
  }, 5 * 60 * 1000);

  // Polling de segurança — funciona mesmo se o Realtime cair (a cada 15s)
  setInterval(() => {
    processPending().catch(e => warn('Polling error:', e.message));
  }, 15 * 1000);
}

/* ============================================================
   SERVIDOR HTTP — pra o Render não dormir + Uptime Robot pingar
   ============================================================ */
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      bot: BOT_USERNAME || BOT_DISPLAY_NAME,
      botId: BOT_ID,
      uptime: Math.floor(process.uptime()) + 's'
    }));
    return;
  }
  res.writeHead(404);
  res.end('Not found');
});

/* ============================================================
   MAIN
   ============================================================ */
(async function main() {
  try {
    await login();
    await processPending();
    listenRealtime();
    heartbeat();

    server.listen(PORT, () => {
      log(`🌐 HTTP escutando na porta ${PORT} — /health pronto`);
    });

    process.on('SIGINT',  () => { log('SIGINT'); process.exit(0); });
    process.on('SIGTERM', () => { log('SIGTERM'); process.exit(0); });

    log('✅ Bloxel está online.');
  } catch (e) {
    console.error('[Bloxel] FATAL:', e);
    process.exit(1);
  }
})();
