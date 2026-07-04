require('dotenv').config();

const express     = require('express');
const compression = require('compression');
const path        = require('path');
const fs          = require('fs');
const crypto      = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// CONFIG
// ============================================================
const SKALEPAY_SECRET_KEY  = process.env.SKALEPAY_SECRET_KEY;
if (!SKALEPAY_SECRET_KEY) {
  console.error('FATAL: variável SKALEPAY_SECRET_KEY não definida.');
  process.exit(1);
}

const SKALEPAY_BASE_URL    = 'https://api.conta.skalepay.com.br/v1';
const SITE_URL             = process.env.SITE_URL || 'https://recarga-online.site';
const VALORES_PERMITIDOS   = new Set([15,17,18,20,25,30,35,40,45,50,55,60,100,200]);
const OPERADORAS_PERMITIDAS = new Set(['Vivo','Claro','TIM','Algar','Correios']);

// Integração UTMify (rastreamento de vendas para atribuição de campanhas/anúncios).
// Sem UTMIFY_API_TOKEN configurado no .env, a integração fica desativada silenciosamente.
const UTMIFY_API_TOKEN = process.env.UTMIFY_API_TOKEN || '';
const UTMIFY_PLATFORM  = process.env.UTMIFY_PLATFORM || 'RecargaFacil';

// Origens extras liberadas via env (ex.: "https://meusite2.com,https://meusite3.com")
const ALLOWED_EXTRA_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

function isOriginAllowed(origin) {
  if (!origin) return false;
  if (origin === SITE_URL) return true;
  if (ALLOWED_EXTRA_ORIGINS.includes(origin)) return true;
  // Libera qualquer subdomínio *.netlify.app (múltiplos front-ends Netlify usando a mesma API)
  return /^https:\/\/([a-z0-9-]+\.)*netlify\.app$/i.test(origin);
}

// ============================================================
// PAGAMENTOS CONFIRMADOS (cache local do webhook)
// ============================================================
const PAGAMENTOS_FILE = path.join(__dirname, 'api', 'logs', 'pagamentos.json');

function lerPagamentoLocal(txId) {
  try {
    if (!fs.existsSync(PAGAMENTOS_FILE)) return null;
    const dados = JSON.parse(fs.readFileSync(PAGAMENTOS_FILE, 'utf8'));
    return dados[txId] ?? null;
  } catch { return null; }
}

function salvarPagamentoLocal(txId, status, metadata) {
  try {
    const dir = path.dirname(PAGAMENTOS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    let dados = {};
    if (fs.existsSync(PAGAMENTOS_FILE)) dados = JSON.parse(fs.readFileSync(PAGAMENTOS_FILE, 'utf8'));
    dados[txId] = { status, metadata, ts: Date.now() };
    // Limpa entradas com mais de 7 dias
    const limite = Date.now() - 7 * 24 * 3600 * 1000;
    for (const [k, v] of Object.entries(dados)) { if (v.ts < limite) delete dados[k]; }
    fs.writeFileSync(PAGAMENTOS_FILE, JSON.stringify(dados), 'utf8');
  } catch (e) { console.error('[pagamentos] Erro ao salvar:', e.message); }
}

// ============================================================
// PEDIDOS UTMIFY (dados do pedido guardados para reenviar com status atualizado)
// ============================================================
const PEDIDOS_UTMIFY_FILE = path.join(__dirname, 'api', 'logs', 'pedidos_utmify.json');

function lerPedidoUtmifyLocal(txId) {
  try {
    if (!fs.existsSync(PEDIDOS_UTMIFY_FILE)) return null;
    const dados = JSON.parse(fs.readFileSync(PEDIDOS_UTMIFY_FILE, 'utf8'));
    return dados[txId] ?? null;
  } catch { return null; }
}

function salvarPedidoUtmifyLocal(txId, pedido) {
  try {
    const dir = path.dirname(PEDIDOS_UTMIFY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    let dados = {};
    if (fs.existsSync(PEDIDOS_UTMIFY_FILE)) dados = JSON.parse(fs.readFileSync(PEDIDOS_UTMIFY_FILE, 'utf8'));
    dados[txId] = { ...pedido, ts: Date.now() };
    const limite = Date.now() - 7 * 24 * 3600 * 1000;
    for (const [k, v] of Object.entries(dados)) { if (v.ts < limite) delete dados[k]; }
    fs.writeFileSync(PEDIDOS_UTMIFY_FILE, JSON.stringify(dados), 'utf8');
  } catch (e) { console.error('[utmify] Erro ao salvar pedido local:', e.message); }
}

// ============================================================
// MIDDLEWARE
// ============================================================
app.use(compression());
app.use(express.json({ limit: '2kb' }));

// CORS + Headers de segurança
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (isOriginAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: https://api.qrserver.com; " +
    "connect-src 'self' https://api.qrserver.com; " +
    "font-src 'self'; " +
    "object-src 'none'; " +
    "base-uri 'self'; " +
    "frame-ancestors 'none'; " +
    "form-action 'self'"
  );
  next();
});

// Serve assets estáticos com cache de 1 ano (imagens, CSS, JS)
// IMPORTANTE: apenas estas pastas/arquivos específicos são públicos. Servir __dirname
// inteiro expunha server.js, package.json, node_modules/ e api/logs/pagamentos.json
// (dados de transações) para qualquer pessoa que acessasse a URL diretamente.
function assetHeaders(res, filePath) {
  if (/sw\.js$/i.test(filePath)) {
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Service-Worker-Allowed', '/');
  } else if (/\.js$/i.test(filePath)) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  } else if (/\.css$/i.test(filePath)) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Content-Type', 'text/css; charset=utf-8');
  } else if (/\.(webp|svg|png|jpg|woff2?|xml|txt)$/i.test(filePath)) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
}

app.use('/css', express.static(path.join(__dirname, 'css'), { setHeaders: assetHeaders }));
app.use('/js', express.static(path.join(__dirname, 'js'), { setHeaders: assetHeaders }));
app.use('/imagens', express.static(path.join(__dirname, 'imagens'), { setHeaders: assetHeaders }));
app.use('/fonts', express.static(path.join(__dirname, 'fonts'), { setHeaders: assetHeaders }));

const PUBLIC_ROOT_FILES = { '/sw.js': 'sw.js', '/robots.txt': 'robots.txt', '/sitemap.xml': 'sitemap.xml' };
app.get(Object.keys(PUBLIC_ROOT_FILES), (req, res) => {
  const filePath = path.join(__dirname, PUBLIC_ROOT_FILES[req.path]);
  assetHeaders(res, filePath);
  res.sendFile(filePath);
});

app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ============================================================
// RATE LIMITING (in-memory)
// ============================================================
const pixRateMap    = new Map(); // rateKey -> [timestamps]
const statusRateMap = new Map(); // ip -> lastTimestamp

function pixRateLimitOk(rateKey) {
  const now     = Date.now();
  const history = (pixRateMap.get(rateKey) || []).filter(t => now - t < 600_000);
  if (history.length >= 5) return false;
  const last = history.length ? Math.max(...history) : 0;
  if (now - last < 5_000) return false;
  history.push(now);
  pixRateMap.set(rateKey, history);
  return true;
}

function statusRateLimitOk(ip) {
  const now  = Date.now();
  const last = statusRateMap.get(ip) || 0;
  if (now - last < 3_000) return false;
  statusRateMap.set(ip, now);
  return true;
}

// ============================================================
// HELPERS
// ============================================================
function getClientIp(req) {
  return ((req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0]).trim();
}

function skalepayAuth() {
  return 'Basic ' + Buffer.from(SKALEPAY_SECRET_KEY + ':x').toString('base64');
}


function gerarCNPJ() {
  const n = Array.from({ length: 12 }, (_, i) => i < 8 ? Math.floor(Math.random() * 9) : 0);
  n[8] = 0; n[9] = 0; n[10] = 0; n[11] = 1;
  const calc = (arr, pesos) => {
    const soma = arr.reduce((s, v, i) => s + v * pesos[i], 0);
    const r = soma % 11;
    return r < 2 ? 0 : 11 - r;
  };
  n.push(calc(n, [5,4,3,2,9,8,7,6,5,4,3,2]));
  n.push(calc(n, [6,5,4,3,2,9,8,7,6,5,4,3,2]));
  return n.join('');
}

// Token derivado da chave secreta — usado para validar que o postback do webhook
// realmente veio da URL que nós geramos (defesa contra chamadas forjadas ao endpoint).
const WEBHOOK_TOKEN = crypto.createHash('sha256').update(SKALEPAY_SECRET_KEY + ':webhook').digest('hex').slice(0, 32);

function toUtmifyDate(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function sanitizeTrackingValue(v) {
  if (typeof v !== 'string') return null;
  const limpo = v.slice(0, 120).trim();
  return limpo || null;
}

function extrairTrackingParams(tracking) {
  const t = tracking && typeof tracking === 'object' ? tracking : {};
  return {
    src:         sanitizeTrackingValue(t.src),
    sck:         sanitizeTrackingValue(t.sck),
    utm_source:  sanitizeTrackingValue(t.utm_source),
    utm_campaign:sanitizeTrackingValue(t.utm_campaign),
    utm_medium:  sanitizeTrackingValue(t.utm_medium),
    utm_content: sanitizeTrackingValue(t.utm_content),
    utm_term:    sanitizeTrackingValue(t.utm_term),
  };
}

// Status da SkalePay -> status aceito pela API da UTMify
const UTMIFY_STATUS_MAP = {
  paid:            'paid',
  waiting_payment: 'waiting_payment',
  pending:         'waiting_payment',
  refused:         'refused',
  refunded:        'refunded',
  chargedback:     'chargedback',
  canceled:        'refused',
};

// Envia/atualiza o pedido na UTMify. Nunca lança erro nem atrasa o fluxo principal de pagamento —
// se a UTMify estiver fora do ar ou mal configurada, a recarga continua funcionando normalmente.
async function enviarUtmify(txId, statusSkalepay) {
  if (!UTMIFY_API_TOKEN) return;

  const pedido = lerPedidoUtmifyLocal(txId);
  if (!pedido) return;

  const status = UTMIFY_STATUS_MAP[statusSkalepay] || 'waiting_payment';
  const body = {
    orderId:       txId,
    platform:      UTMIFY_PLATFORM,
    paymentMethod: 'pix',
    status,
    createdAt:     pedido.createdAt,
    approvedDate:  status === 'paid' ? toUtmifyDate(new Date()) : null,
    refundedAt:    (status === 'refunded' || status === 'chargedback') ? toUtmifyDate(new Date()) : null,
    customer:           pedido.customer,
    products:           pedido.products,
    trackingParameters: pedido.trackingParameters,
    commission:         pedido.commission,
  };

  try {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), 10000);
    const apiRes = await fetch('https://api.utmify.com.br/api-credentials/orders', {
      method:  'POST',
      headers: { 'x-api-token': UTMIFY_API_TOKEN, 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      signal:  ctrl.signal,
    });
    clearTimeout(tid);
    if (!apiRes.ok) {
      const erro = await apiRes.text().catch(() => '');
      console.error('[utmify] resposta não-ok:', apiRes.status, erro);
    }
  } catch (e) {
    console.error('[utmify] Erro ao enviar pedido:', e.message);
  }
}

// ============================================================
// ROTAS API
// ============================================================

// POST /api/pix
app.post('/api/pix', async (req, res) => {
  const ip      = getClientIp(req);
  const rateKey = crypto.createHash('md5').update(ip).digest('hex');

  if (!pixRateLimitOk(rateKey)) {
    return res.status(429).json({ erro: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' });
  }

  const { valor: valorRaw, operadora, telefone: telRaw, tracking } = req.body || {};
  const valor    = parseInt(valorRaw, 10);
  const telefone = String(telRaw || '').replace(/\D/g, '');

  if (!Number.isInteger(valor) || valor <= 0 || !VALORES_PERMITIDOS.has(valor)) {
    return res.status(400).json({ erro: 'Valor de recarga inválido' });
  }
  if (!OPERADORAS_PERMITIDAS.has(operadora)) {
    return res.status(400).json({ erro: 'Operadora inválida' });
  }
  if (telefone.length < 10 || telefone.length > 11) {
    return res.status(400).json({ erro: 'Telefone inválido' });
  }

  const cnpj  = gerarCNPJ();
  const email = `cliente.${crypto.randomBytes(8).toString('hex')}@recarga-online.site`;

  const payload = {
    amount:        valor * 100,
    paymentMethod: 'pix',
    customer: {
      name:     'Recarga Online',
      email,
      phone:    '+55' + telefone,
      document: { number: cnpj, type: 'cnpj' },
    },
    items: [{ title: `Recarga ${operadora}`, quantity: 1, unitPrice: valor * 100, tangible: false }],
    pix:          { expiresInDays: 1 },
    postbackUrl:  `${SITE_URL}/api/webhook?token=${WEBHOOK_TOKEN}`,
    metadata:     JSON.stringify({ telefone, operadora }),
  };

  try {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), 30000);
    const apiRes = await fetch(`${SKALEPAY_BASE_URL}/transactions`, {
      method:  'POST',
      headers: { 'Authorization': skalepayAuth(), 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body:    JSON.stringify(payload),
      signal:  ctrl.signal,
    });
    clearTimeout(tid);

    const dados = await apiRes.json();

    if (!apiRes.ok) {
      let msg = dados.message || dados.error || 'Erro ao criar transação PIX';
      if (Array.isArray(msg)) msg = msg.join(', ');
      console.error('[pix] SkalePay erro:', apiRes.status, msg);
      return res.status(502).json({ erro: msg });
    }

    const pixObj   = dados.pix || {};
    const pixCode  = pixObj.qrcode || pixObj.qrCode || pixObj.qr_code || null;
    const qrCodeUrl = pixObj.qrcodeUrl || pixObj.qrCodeUrl || pixObj.qr_code_url || null;
    const expiresAt = pixObj.expirationDate || pixObj.expiresAt || pixObj.expires_at || null;

    if (!pixCode) return res.status(502).json({ erro: 'Resposta da SkalePay não contém o código PIX' });

    const txId = String(dados.id);
    salvarPedidoUtmifyLocal(txId, {
      createdAt: toUtmifyDate(new Date()),
      customer: { name: 'Recarga Online', email, phone: '+55' + telefone, document: cnpj, country: 'BR', ip },
      products: [{ id: operadora.toLowerCase(), name: `Recarga ${operadora}`, planId: null, planName: null, quantity: 1, priceInCents: valor * 100 }],
      trackingParameters: extrairTrackingParams(tracking),
      commission: { totalPriceInCents: valor * 100, gatewayFeeInCents: 0, userCommissionInCents: valor * 100, currency: 'BRL' },
    });
    enviarUtmify(txId, 'waiting_payment');

    res.json({ sucesso: true, transacaoId: dados.id, pixCode, qrCodeUrl, expiraEm: expiresAt });
  } catch (err) {
    console.error('[pix] Erro:', err.message);
    res.status(500).json({ erro: 'Falha ao conectar com o processador de pagamento' });
  }
});

// GET /api/status?id=TRANSACAO_ID
app.get('/api/status', async (req, res) => {
  const ip = getClientIp(req);
  if (!statusRateLimitOk(ip)) {
    return res.status(429).json({ erro: 'Muitas consultas. Aguarde.' });
  }

  const transacaoId = String(req.query.id || '').replace(/[^a-zA-Z0-9\-_]/g, '');
  if (transacaoId.length < 8 || transacaoId.length > 64) {
    return res.status(400).json({ erro: 'ID da transação inválido' });
  }

  // Consulta cache local primeiro (populado pelo webhook) — evita chamada à API
  const local = lerPagamentoLocal(String(transacaoId));
  if (local) {
    return res.json({ transacaoId, status: local.status, statusRaw: local.status });
  }

  try {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), 15000);
    const apiRes = await fetch(`${SKALEPAY_BASE_URL}/transactions/${transacaoId}`, {
      headers: { 'Authorization': skalepayAuth(), 'Accept': 'application/json' },
      signal:  ctrl.signal,
    });
    clearTimeout(tid);

    if (apiRes.status === 404) return res.status(404).json({ erro: 'Transação não encontrada' });
    if (!apiRes.ok)           return res.status(502).json({ erro: 'Erro ao consultar transação' });

    const dados = await apiRes.json();
    const STATUS_MAP = {
      paid: 'pago', waiting_payment: 'aguardando', pending: 'aguardando',
      refused: 'recusado', refunded: 'estornado', chargedback: 'estornado', canceled: 'cancelado',
    };
    const status = STATUS_MAP[dados.status] || 'aguardando';

    // Se já foi pago, persiste localmente para evitar consultas futuras
    if (status === 'pago') {
      salvarPagamentoLocal(String(transacaoId), status, dados.metadata);
      enviarUtmify(String(transacaoId), dados.status);
    }

    res.json({ transacaoId, status, statusRaw: dados.status });
  } catch (err) {
    res.status(500).json({ erro: 'Falha ao consultar o pagamento' });
  }
});

// POST /api/webhook — chamado pela SkalePay quando pagamento é confirmado
app.post('/api/webhook', (req, res) => {
  res.status(200).send('OK'); // responde rápido para a SkalePay não retentar

  // Valida o token presente na própria URL do postback (gerado por nós no /api/pix).
  // Sem isso, qualquer requisição forjada poderia tentar marcar transações como pagas.
  if (req.query.token !== WEBHOOK_TOKEN) {
    console.warn('[webhook] token inválido — requisição ignorada');
    return;
  }

  const body = req.body || {};
  const txId = String(body.id || body.transaction_id || '').replace(/[^a-zA-Z0-9\-_]/g, '');
  if (!txId) return;

  // Nunca confiamos no campo "status" enviado no corpo: ele pode ser manipulado.
  // O status real é sempre confirmado consultando a API da SkalePay com o ID da transação.
  confirmarStatusNaOrigem(txId);
});

async function confirmarStatusNaOrigem(txId) {
  try {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), 15000);
    const apiRes = await fetch(`${SKALEPAY_BASE_URL}/transactions/${txId}`, {
      headers: { 'Authorization': skalepayAuth(), 'Accept': 'application/json' },
      signal:  ctrl.signal,
    });
    clearTimeout(tid);
    if (!apiRes.ok) return;

    const dados = await apiRes.json();
    const STATUS_MAP = {
      paid: 'pago', waiting_payment: 'aguardando', pending: 'aguardando',
      refused: 'recusado', refunded: 'estornado', chargedback: 'estornado', canceled: 'cancelado',
    };
    const status = STATUS_MAP[dados.status] || 'aguardando';

    console.log(`[webhook] txId=${txId} status confirmado na origem=${status}`);
    salvarPagamentoLocal(txId, status, dados.metadata);
    enviarUtmify(txId, dados.status);
  } catch (e) {
    console.error('[webhook] Erro ao confirmar status na origem:', e.message);
  }
}

// ============================================================
// START
// ============================================================
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
