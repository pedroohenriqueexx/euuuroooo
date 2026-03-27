<?php
declare(strict_types=1);

/**
 * webhook-cooud.php
 *
 * Recebe webhook da Cooud e envia Purchase para o PostHog.
 *
 * Como usar:
 * 1) Salve este arquivo no servidor, ex: /public_html/webhook-cooud.php
 * 2) Configure a URL no painel da Cooud
 * 3) Troque as constantes abaixo
 * 4) Teste com um pagamento real ou reenvio de webhook
 */

header('Content-Type: application/json; charset=utf-8');

/* =========================
   CONFIG
   ========================= */

const POSTHOG_ENDPOINT = 'https://us.i.posthog.com/i/v0/e/';
const POSTHOG_PROJECT_API_KEY = 'phc_AjtNo7WcPDHt2By14rADXptDtLTTURcVNlO77lLjYeq';

/**
 * Se você tiver alguma assinatura/secreto do webhook da Cooud, coloque aqui.
 * Se não tiver, deixe vazio.
 */
const WEBHOOK_SECRET = '';

/**
 * Pasta para logs e deduplicação
 */
const STORAGE_DIR = __DIR__ . '/cooud_webhook_storage';
const LOG_FILE    = STORAGE_DIR . '/webhook.log';

/* =========================
   HELPERS
   ========================= */

function ensureStorage(): void
{
    if (!is_dir(STORAGE_DIR)) {
        mkdir(STORAGE_DIR, 0775, true);
    }
}

function logLine(string $message, array $context = []): void
{
    ensureStorage();

    $line = '[' . date('Y-m-d H:i:s') . '] ' . $message;
    if (!empty($context)) {
        $line .= ' | ' . json_encode($context, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    }
    $line .= PHP_EOL;

    file_put_contents(LOG_FILE, $line, FILE_APPEND);
}

function jsonResponse(int $statusCode, array $data): void
{
    http_response_code($statusCode);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function getHeaderValue(string $name): ?string
{
    $key = 'HTTP_' . strtoupper(str_replace('-', '_', $name));
    return $_SERVER[$key] ?? null;
}

function verifyWebhookSecret(string $rawBody): bool
{
    if (WEBHOOK_SECRET === '') {
        return true;
    }

    /**
     * Ajuste este trecho conforme a forma real de assinatura do seu webhook.
     * Exemplo genérico usando header X-Webhook-Secret ou X-Signature.
     */
    $headerSecret = getHeaderValue('X-Webhook-Secret');
    if ($headerSecret && hash_equals(WEBHOOK_SECRET, $headerSecret)) {
        return true;
    }

    $headerSignature = getHeaderValue('X-Signature');
    if ($headerSignature) {
        $expected = hash_hmac('sha256', $rawBody, WEBHOOK_SECRET);
        if (hash_equals($expected, $headerSignature)) {
            return true;
        }
    }

    return false;
}

function arrGet(array $data, array $paths, $default = null)
{
    foreach ($paths as $path) {
        $segments = explode('.', $path);
        $value = $data;
        $found = true;

        foreach ($segments as $segment) {
            if (is_array($value) && array_key_exists($segment, $value)) {
                $value = $value[$segment];
            } else {
                $found = false;
                break;
            }
        }

        if ($found) {
            return $value;
        }
    }

    return $default;
}

function normalizeStatus(?string $status): string
{
    $status = strtolower(trim((string)$status));

    $map = [
        'paid'      => 'paid',
        'approved'  => 'paid',
        'aprovado'  => 'paid',
        'success'   => 'paid',
        'succeeded' => 'paid',
        'complete'  => 'paid',
        'completed' => 'paid',
        'pending'   => 'pending',
        'waiting'   => 'pending',
        'expired'   => 'expired',
        'refused'   => 'failed',
        'failed'    => 'failed',
        'cancelled' => 'cancelled',
        'canceled'  => 'cancelled',
        'chargeback'=> 'chargeback',
    ];

    return $map[$status] ?? $status;
}

function parseAmountToFloat($rawAmount): float
{
    if ($rawAmount === null || $rawAmount === '') {
        return 0.0;
    }

    if (is_numeric($rawAmount)) {
        $amount = (float)$rawAmount;

        /**
         * Se vier em centavos, converte.
         * Regra prática:
         * valores acima de 999 provavelmente estão em centavos.
         */
        if ($amount > 999) {
            return round($amount / 100, 2);
        }

        return round($amount, 2);
    }

    $normalized = str_replace(['R$', ' '], '', (string)$rawAmount);
    $normalized = str_replace('.', '', $normalized);
    $normalized = str_replace(',', '.', $normalized);

    return round((float)$normalized, 2);
}

function getDistinctId(array $payload, ?string $transactionId): string
{
    $distinctId = arrGet($payload, [
        'ph_distinct_id',
        'metadata.ph_distinct_id',
        'meta.ph_distinct_id',
        'custom_fields.ph_distinct_id',
        'tracking.ph_distinct_id',
        'customer.ph_distinct_id',
        'query.ph_distinct_id',
    ]);

    if (is_string($distinctId) && trim($distinctId) !== '') {
        return trim($distinctId);
    }

    if ($transactionId) {
        return 'cooud_' . $transactionId;
    }

    return 'cooud_unknown_' . md5(json_encode($payload));
}

function hasAlreadyProcessed(string $transactionId, string $normalizedStatus): bool
{
    ensureStorage();

    $safeTx = preg_replace('/[^a-zA-Z0-9_\-]/', '_', $transactionId);
    $file = STORAGE_DIR . '/processed_' . $safeTx . '.json';

    if (!file_exists($file)) {
        return false;
    }

    $content = json_decode((string)file_get_contents($file), true);
    if (!is_array($content)) {
        return false;
    }

    return (($content['status'] ?? '') === $normalizedStatus);
}

function markProcessed(string $transactionId, string $normalizedStatus, array $extra = []): void
{
    ensureStorage();

    $safeTx = preg_replace('/[^a-zA-Z0-9_\-]/', '_', $transactionId);
    $file = STORAGE_DIR . '/processed_' . $safeTx . '.json';

    $payload = array_merge([
        'transaction_id' => $transactionId,
        'status' => $normalizedStatus,
        'processed_at' => date('c'),
    ], $extra);

    file_put_contents(
        $file,
        json_encode($payload, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)
    );
}

function sendPurchaseToPostHog(array $event): array
{
    $ch = curl_init(POSTHOG_ENDPOINT);

    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => json_encode($event, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
        CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 20,
    ]);

    $responseBody = curl_exec($ch);
    $curlError    = curl_error($ch);
    $httpCode     = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);

    curl_close($ch);

    return [
        'ok' => ($curlError === '' && $httpCode >= 200 && $httpCode < 300),
        'http_code' => $httpCode,
        'curl_error' => $curlError,
        'response_body' => $responseBody,
    ];
}

/* =========================
   INÍCIO
   ========================= */

ensureStorage();

$rawBody = file_get_contents('php://input');
logLine('Webhook recebido', ['raw' => $rawBody]);

if ($rawBody === false || trim($rawBody) === '') {
    jsonResponse(400, ['ok' => false, 'error' => 'empty_body']);
}

if (!verifyWebhookSecret($rawBody)) {
    logLine('Falha na validação do segredo');
    jsonResponse(401, ['ok' => false, 'error' => 'invalid_signature']);
}

$payload = json_decode($rawBody, true);

if (!is_array($payload)) {
    logLine('JSON inválido');
    jsonResponse(400, ['ok' => false, 'error' => 'invalid_json']);
}

/**
 * Ajuste este mapeamento conforme o payload real da Cooud, se necessário.
 */
$eventName = arrGet($payload, [
    'event',
    'type',
    'action',
], '');

$status = arrGet($payload, [
    'status',
    'payment_status',
    'data.status',
    'data.payment_status',
    'transaction.status',
    'order.status',
], '');

$transactionId = arrGet($payload, [
    'transaction_id',
    'id',
    'order_id',
    'payment_id',
    'data.id',
    'data.transaction_id',
    'data.order_id',
    'transaction.id',
    'order.id',
], null);

$amountRaw = arrGet($payload, [
    'amount',
    'total',
    'value',
    'price',
    'data.amount',
    'data.total',
    'transaction.amount',
    'order.amount',
], 0);

$currency = (string)arrGet($payload, [
    'currency',
    'data.currency',
    'transaction.currency',
    'order.currency',
], 'BRL');

$productName = arrGet($payload, [
    'product_name',
    'offer_name',
    'data.product_name',
    'data.offer_name',
    'product.name',
    'order.product_name',
], 'Main Offer');

$email = arrGet($payload, [
    'customer.email',
    'data.customer.email',
    'buyer.email',
    'email',
], null);

$name = arrGet($payload, [
    'customer.name',
    'data.customer.name',
    'buyer.name',
    'name',
], null);

$normalizedStatus = normalizeStatus((string)$status);

logLine('Webhook parseado', [
    'event' => $eventName,
    'status' => $status,
    'normalized_status' => $normalizedStatus,
    'transaction_id' => $transactionId,
]);

/**
 * Só processa compra paga.
 */
if ($normalizedStatus !== 'paid') {
    jsonResponse(200, [
        'ok' => true,
        'ignored' => true,
        'reason' => 'status_not_paid',
        'status' => $normalizedStatus,
    ]);
}

if (!$transactionId) {
    /**
     * Ainda permite processar, mas sem id de transação fica mais frágil.
     */
    $transactionId = 'tx_' . md5($rawBody);
}

if (hasAlreadyProcessed($transactionId, $normalizedStatus)) {
    logLine('Evento já processado anteriormente', ['transaction_id' => $transactionId]);
    jsonResponse(200, [
        'ok' => true,
        'duplicate' => true,
        'transaction_id' => $transactionId,
    ]);
}

$distinctId = getDistinctId($payload, $transactionId);
$amount     = parseAmountToFloat($amountRaw);

/**
 * event_id ajuda deduplicação/referência no PostHog
 */
$eventId = 'purchase_' . $transactionId;

/**
 * Payload para o PostHog
 */
$posthogEvent = [
    'api_key' => POSTHOG_PROJECT_API_KEY,
    'event' => 'Purchase',
    'distinct_id' => $distinctId,
    'properties' => [
        'distinct_id' => $distinctId,
        'transaction_id' => $transactionId,
        'event_id' => $eventId,
        'value' => $amount,
        'currency' => $currency ?: 'BRL',
        'gateway' => 'cooud',
        'gateway_status' => $status,
        'normalized_status' => $normalizedStatus,
        'product_name' => $productName,
        'customer_email' => $email,
        'customer_name' => $name,
        'source' => 'cooud_webhook',
        'raw_event_name' => $eventName,
        '$current_url' => 'cooud_webhook',
    ],
    'timestamp' => gmdate('c'),
];

$result = sendPurchaseToPostHog($posthogEvent);

logLine('Resposta do PostHog', $result);

if (!$result['ok']) {
    jsonResponse(500, [
        'ok' => false,
        'error' => 'posthog_request_failed',
        'posthog' => $result,
    ]);
}

markProcessed($transactionId, $normalizedStatus, [
    'distinct_id' => $distinctId,
    'amount' => $amount,
    'currency' => $currency,
    'event_id' => $eventId,
]);

jsonResponse(200, [
    'ok' => true,
    'message' => 'Purchase enviado ao PostHog com sucesso',
    'transaction_id' => $transactionId,
    'distinct_id' => $distinctId,
    'amount' => $amount,
    'currency' => $currency,
]);